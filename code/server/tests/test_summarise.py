"""Budget-driven summarisation.

The property that matters most is conservation: a slice defers detail, it never
discards it. Every leaf of the full subtree is either displayed or counted
inside exactly one wedge.
"""

from __future__ import annotations

import numpy as np
import pytest

from phylodelta.trees.newick import parse_newick
from phylodelta.trees.store import TreeMeta, read_tree, write_tree
from phylodelta.trees.summarise import Summariser, count_leaves, flatten


def make(tmp_path, newick: str) -> Summariser:
    arrays = parse_newick(newick)
    write_tree(
        tmp_path / "t", arrays,
        TreeMeta(id="t", species="s", method="upgma", source="",
                 n_nodes=0, n_leaves=0, max_depth=0),
    )
    return Summariser(read_tree(tmp_path / "t"))


def accounted(node) -> int:
    """Displayed real leaves plus leaves standing behind wedges."""
    flat = flatten(node)
    wedges = sum(
        c for c, cut in zip(flat["true_leaf_count"], flat["truncated"]) if cut
    )
    return wedges + (count_leaves(node) - sum(flat["truncated"]))


# --- the conservation invariant -------------------------------------------

@pytest.mark.parametrize("budget", [1, 2, 3, 5, 8, 13, 50])
def test_nothing_is_lost_at_any_budget(tmp_path, budget):
    s = make(tmp_path, "((((A,B),(C,D)),((E,F),(G,H))),(((I,J),(K,L)),((M,N),(O,P))));")
    node = s.summarise(0, budget)
    assert accounted(node) == 16
    assert count_leaves(node) <= budget


@pytest.mark.parametrize("budget", [1, 2, 7, 25, 100, 500])
def test_nothing_is_lost_on_a_real_tree(real_store, budget):
    reader = read_tree(real_store / "trees" / "vibrio-upgma")
    node = Summariser(reader).summarise(0, budget)
    assert accounted(node) == reader.meta.n_leaves
    assert count_leaves(node) <= budget


# --- the budget ------------------------------------------------------------

def test_a_budget_of_one_gives_a_single_wedge(tmp_path):
    s = make(tmp_path, "((A,B),(C,D));")
    node = s.summarise(0, 1)
    assert node.truncated is True
    assert node.true_leaf_count == 4
    assert node.children == []


def test_a_sufficient_budget_returns_the_whole_subtree(tmp_path):
    s = make(tmp_path, "((A,B),(C,D));")
    node = s.summarise(0, 99)
    flat = flatten(node)
    assert count_leaves(node) == 4
    assert not any(flat["truncated"])
    assert sorted(x for x in flat["label"] if x) == ["A", "B", "C", "D"]


def test_a_leaf_is_never_marked_truncated(tmp_path):
    s = make(tmp_path, "((A,B),(C,D));")
    flat = flatten(s.summarise(0, 99))
    for label, cut in zip(flat["label"], flat["truncated"]):
        if label:
            assert not cut


# --- selection order -------------------------------------------------------

def test_detail_goes_to_the_largest_clade_first(tmp_path):
    """One big clade and one small: a tight budget expands the big one."""
    s = make(tmp_path, "(((A,B),(C,D)),(E,F));")   # left has 4 leaves, right 2
    flat = flatten(s.summarise(0, 3))
    kept = {i: c for i, c in zip(flat["true_leaf_count"], flat["truncated"])}
    # The 4-leaf clade got the detail; the 2-leaf one is a wedge.
    assert 2 in kept and kept[2] is True


def test_every_child_survives_as_at_least_a_wedge(tmp_path):
    """The divergence from the library: siblings are never silently dropped."""
    s = make(tmp_path, "((((A,B),(C,D)),((E,F),(G,H))),(I,J));")
    node = s.summarise(0, 2)
    assert len(node.children) == 2
    assert all(c.truncated for c in node.children)
    assert {c.true_leaf_count for c in node.children} == {8, 2}


def test_is_deterministic(real_store):
    reader = read_tree(real_store / "trees" / "vibrio-upgma")
    s = Summariser(reader)
    assert flatten(s.summarise(0, 200)) == flatten(s.summarise(0, 200))


# --- structure -------------------------------------------------------------

def test_flatten_is_pre_order_with_valid_parents(real_store):
    reader = read_tree(real_store / "trees" / "vibrio-upgma")
    flat = flatten(Summariser(reader).summarise(0, 300))
    assert flat["parent"][0] == -1
    for i, p in enumerate(flat["parent"][1:], start=1):
        assert 0 <= p < i, "a parent must already have been emitted"


def test_ids_are_stored_tree_ids(real_store):
    """The join key: a slice id must address the same node in the store."""
    reader = read_tree(real_store / "trees" / "vibrio-upgma")
    flat = flatten(Summariser(reader).summarise(0, 100))
    for node_id, true_count in zip(flat["id"], flat["true_leaf_count"]):
        assert int(reader.leaf_count[node_id]) == true_count


def test_a_wedge_can_be_expanded_by_slicing_at_its_id(real_store):
    """The navigation loop: expanding a wedge is a slice rooted at it."""
    reader = read_tree(real_store / "trees" / "vibrio-upgma")
    s = Summariser(reader)
    flat = flatten(s.summarise(0, 20))
    wedge = next(
        i for i, cut in zip(flat["id"], flat["truncated"]) if cut
    )
    expanded = s.summarise(wedge, 50)
    assert accounted(expanded) == int(reader.leaf_count[wedge])


def test_out_of_range_root_is_rejected(real_store):
    reader = read_tree(real_store / "trees" / "vibrio-upgma")
    with pytest.raises(IndexError):
        Summariser(reader).summarise(reader.meta.n_nodes, 10)


def test_deep_tree_does_not_recurse(tmp_path):
    """A 5,000-level caterpillar: the browser's recursive version would overflow."""
    depth = 5_000
    text = "(" * depth + "L0" + "".join(f",L{i})" for i in range(1, depth + 1)) + ";"
    s = make(tmp_path, text)
    node = s.summarise(0, 100)
    assert count_leaves(node) <= 100
    assert accounted(node) == depth + 1
