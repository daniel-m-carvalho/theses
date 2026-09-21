"""Restricting a pair to their shared leaves."""

from __future__ import annotations

import numpy as np
import pytest

from phylocmp.trees.newick import parse_newick
from phylocmp.trees.normalise import assert_rooted_binary
from phylocmp.trees.reconcile import leaf_labels, reconcile, restrict_to_leaves


def test_identical_leaf_sets_are_left_alone():
    a = parse_newick("((A,B),(C,D));")
    b = parse_newick("((A,C),(B,D));")
    left, right, report = reconcile(a, b)
    assert report.is_identity
    assert report.shared == 4
    assert left.n_nodes == a.n_nodes and right.n_nodes == b.n_nodes


def test_drops_only_the_unshared_leaf():
    """The vibrio situation in miniature: one leaf present on one side only."""
    a = parse_newick("(((A,B),X),(C,D));")
    b = parse_newick("((A,C),(B,D));")
    left, right, report = reconcile(a, b)
    assert report.dropped_left == ["X"]
    assert report.dropped_right == []
    assert report.shared == 4
    assert sorted(leaf_labels(left)) == ["A", "B", "C", "D"]
    assert_rooted_binary(left)
    assert_rooted_binary(right)


def test_pruning_leaves_a_canonical_tree():
    """Removing a leaf makes its parent unary; the result must still be binary."""
    a = parse_newick("((A,X),(B,(C,D)));")
    b = parse_newick("(((A,B),C),D);")
    left, _, _ = reconcile(a, b)
    assert_rooted_binary(left)
    assert left.n_nodes == 2 * left.n_leaves - 1


def test_source_index_maps_back_to_the_original_tree():
    """The mapping that keeps computed values aligned with the stored tree."""
    a = parse_newick("(((A,B),X),(C,D));")
    b = parse_newick("((A,C),(B,D));")
    left, _, report = reconcile(a, b)
    assert report.left_source_index is not None
    assert len(report.left_source_index) == left.n_nodes
    # Every surviving node still carries the label it had in the source tree.
    for new_i, old_i in enumerate(report.left_source_index):
        assert left.labels[new_i] == a.labels[int(old_i)]


def test_no_shared_leaves_is_refused():
    a = parse_newick("((A,B),C);")
    b = parse_newick("((X,Y),Z);")
    with pytest.raises(ValueError, match="share no leaf labels"):
        reconcile(a, b)


def test_restrict_keeps_interval_encoding_valid():
    a = parse_newick("(((A,B),(C,X)),((D,E),F));")
    r = restrict_to_leaves(a, {"A", "B", "C", "D", "E", "F"})
    end = np.asarray(r.subtree_end)
    for i in range(r.n_nodes):
        in_range = sum(1 for j in range(i, int(end[i])) if end[j] == j + 1)
        assert r.leaf_count[i] == in_range
