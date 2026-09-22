"""Parser behaviour, on constructed trees where the answer is known by hand."""

from __future__ import annotations

import math

import numpy as np
import pytest

from phylodelta.trees.newick import NO_PARENT, parse_newick


def test_single_leaf():
    t = parse_newick("A;")
    assert t.n_nodes == 1
    assert t.n_leaves == 1
    assert t.labels == ["A"]
    assert t.parent[0] == NO_PARENT
    assert t.subtree_end[0] == 1


def test_pre_order_and_intervals():
    #        r
    #      /   \
    #     x     D
    #    /|\
    #   A B C
    t = parse_newick("((A,B,C)x,D)r;")
    assert t.labels == ["r", "x", "A", "B", "C", "D"]
    assert list(t.subtree_end) == [6, 5, 3, 4, 5, 6]
    assert list(t.parent) == [NO_PARENT, 0, 1, 1, 1, 0]
    assert list(t.depth) == [0, 1, 2, 2, 2, 1]
    assert list(t.leaf_count) == [4, 3, 1, 1, 1, 1]


def test_subtree_is_a_contiguous_range():
    """The property the whole storage design rests on."""
    t = parse_newick("(((A,B),(C,D)),((E,F),G));")
    for i in range(t.n_nodes):
        descendants = range(i + 1, int(t.subtree_end[i]))
        # Everything in the range descends from i...
        for j in descendants:
            ancestor = j
            while ancestor != i and ancestor != NO_PARENT:
                ancestor = int(t.parent[ancestor])
            assert ancestor == i, f"{j} is in {i}'s range but not its descendant"
        # ...and nothing outside it does.
        for j in range(t.n_nodes):
            if j in descendants or j == i:
                continue
            ancestor = j
            while ancestor != NO_PARENT:
                ancestor = int(t.parent[ancestor])
                assert ancestor != i, f"{j} descends from {i} but is outside its range"


def test_leaf_count_equals_leaves_in_range():
    t = parse_newick("(((A,B),(C,D)),((E,F),G));")
    for i in range(t.n_nodes):
        in_range = sum(
            1 for j in range(i, int(t.subtree_end[i])) if t.subtree_end[j] == j + 1
        )
        assert t.leaf_count[i] == in_range


def test_branch_lengths_and_missing_lengths():
    t = parse_newick("(A:1.5,B)root;")
    assert t.branch_len[t.labels.index("A")] == np.float32(1.5)
    assert math.isnan(float(t.branch_len[t.labels.index("B")]))
    assert math.isnan(float(t.branch_len[0]))


def test_quoted_labels_may_contain_structure():
    t = parse_newick("('a,b':2,'c(d)')r;")
    assert t.labels == ["r", "a,b", "c(d)"]


def test_unnamed_internal_nodes():
    """The real files label every internal node '_', which must not become a leaf."""
    t = parse_newick("((A:1,B:1)_:2,C:3)_;")
    assert t.n_leaves == 3
    assert t.labels == ["_", "_", "A", "B", "C"]


def test_deep_tree_does_not_recurse():
    """A 20k-level caterpillar: recursive descent would blow the stack here."""
    depth = 20_000
    text = "(" * depth + "L0" + "".join(f",L{i})" for i in range(1, depth + 1)) + ";"
    t = parse_newick(text)
    assert t.n_leaves == depth + 1
    assert t.max_depth == depth


@pytest.mark.parametrize("bad", ["(A,B));", "((A,B);", ""])
def test_malformed_input_raises(bad):
    with pytest.raises(ValueError):
        parse_newick(bad)


def test_doubled_quote_inside_a_quoted_label():
    """Newick escapes a quote inside a quoted label by doubling it.

    Found by the writer: it emitted the correct escape and the parser could not
    read it back. The datasets here are integer sequence types and never
    exercise this, which is luck rather than a guarantee.
    """
    t = parse_newick("('O''Brien':1,'say ''hi''')r;")
    assert t.labels == ["r", "O'Brien", "say 'hi'"]


def test_quoted_label_may_be_empty():
    assert parse_newick("('',B);").labels[1] == ""


def test_parse_newick_fast_falls_back_when_the_extension_is_absent(monkeypatch):
    """The extension is optional; without it the Python parser answers.

    This is the configuration a machine with no compiler runs, so it is tested
    whether or not the extension happens to be built here.
    """
    from phylodelta.trees import native, newick

    monkeypatch.setattr(native, "extension", lambda: None)
    got = newick.parse_newick_fast("((A,B),(C,D));")
    assert got.n_leaves == 4
    assert got.labels[1] == ""


def test_describe_reports_which_parser_is_in_use(monkeypatch):
    from phylodelta.trees import native

    monkeypatch.setattr(native, "extension", lambda: None)
    assert native.describe() == "python"
