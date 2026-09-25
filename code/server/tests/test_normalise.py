"""Unary-node suppression: the canonicalisation the store's contract depends on."""

from __future__ import annotations

import math
import re

import numpy as np
import pytest

from phylodelta.trees.newick import NO_PARENT, parse_newick
from phylodelta.trees.normalise import (
    NotRootedBinary,
    assert_rooted_binary,
    resolve_trifurcating_root,
    suppress_unary,
)


def test_nothing_to_do_returns_the_same_object():
    arrays = parse_newick("((A,B),(C,D));")
    result, removed = suppress_unary(arrays)
    assert removed == 0
    assert result is arrays


def test_unary_root_is_removed():
    """The shape vibrio-nj actually arrives in: (X);"""
    arrays, removed = suppress_unary(parse_newick("(((A,B),(C,D)));"))
    assert removed == 1
    assert_rooted_binary(arrays)
    assert arrays.n_nodes == 2 * arrays.n_leaves - 1
    assert arrays.labels == ["", "", "A", "B", "", "C", "D"]


def test_chain_of_unary_nodes_collapses_in_one_pass():
    arrays, removed = suppress_unary(parse_newick("((((A,B))))x;"))
    assert removed == 3
    assert arrays.n_nodes == 3
    assert list(arrays.leaf_count) == [2, 1, 1]


def test_branch_lengths_are_preserved_not_discarded():
    """Suppression must not change any root-to-leaf distance."""
    arrays, removed = suppress_unary(parse_newick("((A:1.0,B:2.0):3.0):4.0;"))
    assert removed == 1
    # The suppressed node's 3.0 is added to nothing above it (it became the
    # root), and the leaves keep their own lengths.
    assert arrays.labels == ["", "A", "B"]
    assert float(arrays.branch_len[1]) == pytest.approx(1.0)
    assert float(arrays.branch_len[2]) == pytest.approx(2.0)


def test_suppressed_length_passes_to_the_child():
    """Root-to-leaf distance is unchanged: the dead node's 3.0 joins the 7.0."""
    arrays, removed = suppress_unary(parse_newick("(((A:1.0,B:2.0):3.0):7.0,C:5.0)r;"))
    assert removed == 1
    assert arrays.labels == ["r", "", "A", "B", "C"]
    assert float(arrays.branch_len[1]) == pytest.approx(10.0)
    assert float(arrays.branch_len[2]) == pytest.approx(1.0)
    assert float(arrays.branch_len[4]) == pytest.approx(5.0)


def test_absent_lengths_stay_absent():
    arrays, removed = suppress_unary(parse_newick("(((A,B)));"))
    assert removed == 2
    assert all(math.isnan(float(v)) for v in arrays.branch_len)


def test_intervals_remain_contiguous_after_reindexing():
    arrays, _ = suppress_unary(parse_newick("((((A,B),(C,D))),((E,F),G));"))
    assert_rooted_binary(arrays)
    for i in range(arrays.n_nodes):
        for j in range(i + 1, int(arrays.subtree_end[i])):
            ancestor = j
            while ancestor != i and ancestor != NO_PARENT:
                ancestor = int(arrays.parent[ancestor])
            assert ancestor == i


def test_non_binary_is_reported_not_silently_accepted():
    """A polytomy is not something suppression can fix, so it must fail loudly."""
    with pytest.raises(NotRootedBinary, match="not a binary tree"):
        assert_rooted_binary(parse_newick("(A,B,C);"))


# --- a trifurcating root: the unrooted form NJ tools write -----------------


def _clusters(arrays):
    """Every internal node's leaf set -- what a rooted metric compares."""
    out = set()
    for i in range(arrays.n_nodes):
        end = int(arrays.subtree_end[i])
        if end != i + 1:
            out.add(frozenset(arrays.labels[j] for j in range(i, end) if arrays.subtree_end[j] == j + 1))
    return out


def _assert_consistent(arrays):
    """Every column agrees with `parent`, which is the column the others derive from."""
    assert_rooted_binary(arrays)
    for i in range(1, arrays.n_nodes):
        p = int(arrays.parent[i])
        assert p < i and i < int(arrays.subtree_end[p])
        assert int(arrays.depth[i]) == int(arrays.depth[p]) + 1
    for i in range(arrays.n_nodes):
        end = int(arrays.subtree_end[i])
        leaves = sum(1 for j in range(i, end) if arrays.subtree_end[j] == j + 1)
        assert int(arrays.leaf_count[i]) == leaves


def test_a_binary_root_is_left_alone():
    arrays = parse_newick("((A,B),(C,D));")
    result, resolved = resolve_trifurcating_root(arrays)
    assert resolved is False and result is arrays


def test_trifurcating_root_is_resolved_on_its_longest_branch():
    source = parse_newick("((A:1,B:1):0.5,C:9,(D:1,E:1):2);")
    arrays, resolved = resolve_trifurcating_root(source)
    assert resolved is True
    _assert_consistent(arrays)
    assert arrays.n_leaves == 5 and arrays.n_nodes == 9
    # C is on the longest branch, so it stays under the root and the other
    # two are joined: exactly one clade is added, and none is lost.
    assert _clusters(arrays) == _clusters(source) | {frozenset("ABDE")}


def test_the_choice_does_not_depend_on_which_child_is_written_first():
    first = parse_newick("(C:9,(A:1,B:1):0.5,(D:1,E:1):2);")
    last = parse_newick("((A:1,B:1):0.5,(D:1,E:1):2,C:9);")
    a, _ = resolve_trifurcating_root(first)
    b, _ = resolve_trifurcating_root(last)
    assert _clusters(a) == _clusters(b)


def test_root_to_leaf_distances_are_unchanged():
    """The new branch is zero-length, so no leaf moves."""
    def distances(arrays):
        out = {}
        for i in range(arrays.n_nodes):
            if arrays.subtree_end[i] == i + 1:
                d, j = 0.0, i
                while j != 0:
                    d += float(arrays.branch_len[j])
                    j = int(arrays.parent[j])
                out[arrays.labels[i]] = d
        return out

    source = parse_newick("((A:1,B:2):3,C:4,D:5);")
    arrays, _ = resolve_trifurcating_root(source)
    assert distances(arrays) == pytest.approx(distances(source))


def test_absent_lengths_stay_absent_when_resolving():
    arrays, resolved = resolve_trifurcating_root(parse_newick("((A,B),C,D);"))
    assert resolved is True
    _assert_consistent(arrays)
    assert all(math.isnan(float(v)) for v in arrays.branch_len)


def test_a_unary_root_over_a_trifurcation_is_resolved_after_suppression():
    arrays, removed = suppress_unary(parse_newick("((A:1,B:2,C:3));"))
    arrays, resolved = resolve_trifurcating_root(arrays)
    assert removed == 1 and resolved is True
    _assert_consistent(arrays)


@pytest.mark.parametrize(
    "newick, says",
    [
        ("(A,B,C,D);", "root has 4 children"),
        ("((A,B,C),D);", "1 node(s) below the root"),
    ],
)
def test_a_real_polytomy_is_still_refused_and_says_where(newick, says):
    arrays, resolved = resolve_trifurcating_root(parse_newick(newick))
    assert resolved is False
    with pytest.raises(NotRootedBinary, match=re.escape(says)):
        assert_rooted_binary(arrays)
