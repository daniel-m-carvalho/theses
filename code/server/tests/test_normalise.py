"""Unary-node suppression: the canonicalisation the store's contract depends on."""

from __future__ import annotations

import math

import numpy as np
import pytest

from phylocmp.trees.newick import NO_PARENT, parse_newick
from phylocmp.trees.normalise import assert_rooted_binary, suppress_unary


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
    with pytest.raises(ValueError, match="not binary"):
        assert_rooted_binary(parse_newick("(A,B,C);"))
