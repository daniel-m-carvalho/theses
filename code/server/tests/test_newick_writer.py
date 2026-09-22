"""Writing Newick back out, and materialising a pair for a subprocess metric.

The property that matters is round-tripping: whatever a subprocess metric is
handed must be the tree we think we handed it.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from phylodelta.trees.materialise import MaterialisedPair
from phylodelta.trees.newick import parse_newick
from phylodelta.trees.newick_writer import to_newick, write_newick


def assert_round_trips(text: str) -> None:
    original = parse_newick(text)
    back = parse_newick(to_newick(original))
    assert back.labels == original.labels
    np.testing.assert_array_equal(
        np.asarray(back.subtree_end), np.asarray(original.subtree_end)
    )
    np.testing.assert_array_equal(np.asarray(back.parent), np.asarray(original.parent))
    a, b = np.asarray(original.branch_len), np.asarray(back.branch_len)
    np.testing.assert_array_equal(np.isnan(a), np.isnan(b))
    np.testing.assert_allclose(a[~np.isnan(a)], b[~np.isnan(b)], rtol=1e-6)


@pytest.mark.parametrize(
    "text",
    [
        "A;",
        "(A,B);",
        "((A,B),(C,D));",
        "((A:1.5,B)x:2,C:3)root;",
        "((A,B)_:2,C)_;",
        "(((A,B),C),(D,(E,F)));",
        "(A:0.0001,B:12345.678);",
    ],
)
def test_round_trips(text):
    assert_round_trips(text)


def test_labels_with_structural_characters_are_quoted():
    """An unquoted comma in a label would reparse as a different tree."""
    text = "('a,b':2,'c(d)')r;"
    assert_round_trips(text)
    out = to_newick(parse_newick(text))
    assert "'a,b'" in out and "'c(d)'" in out


def test_an_apostrophe_in_a_label_survives():
    arrays = parse_newick("('O''Brien',B);")
    assert arrays.labels[1] == "O'Brien"
    assert parse_newick(to_newick(arrays)).labels[1] == "O'Brien"


def test_absent_lengths_stay_absent():
    """NaN means the source gave no length; writing ':nan' would be a lie."""
    out = to_newick(parse_newick("(A:1,B)r;"))
    assert "nan" not in out.lower()
    assert out.count(":") == 1


def test_lengths_can_be_dropped_entirely():
    """How a caller asks a tool for an unweighted distance.

    TreeDiff infers weighted mode from the first ':' it sees and silently
    returns wRF instead of RF, so this is a correctness control, not cosmetic.
    """
    out = to_newick(parse_newick("((A:1.5,B:2)x:3,C:4)r;"), include_lengths=False)
    assert ":" not in out
    assert parse_newick(out).n_leaves == 3


def test_internal_labels_can_be_dropped():
    out = to_newick(parse_newick("((A,B)x,C)root;"), include_internal_labels=False)
    assert "x" not in out and "root" not in out
    assert parse_newick(out).n_leaves == 3


def test_deep_tree_does_not_recurse():
    """5,000 levels: a recursive writer would overflow, as the real trees are 604 deep."""
    depth = 5_000
    text = "(" * depth + "L0" + "".join(f",L{i})" for i in range(1, depth + 1)) + ";"
    assert parse_newick(to_newick(parse_newick(text))).n_leaves == depth + 1


def test_empty_tree_is_refused():
    from phylodelta.trees.newick import TreeArrays

    empty = TreeArrays(
        parent=np.array([], dtype=np.uint32),
        subtree_end=np.array([], dtype=np.uint32),
        depth=np.array([], dtype=np.uint16),
        leaf_count=np.array([], dtype=np.uint32),
        branch_len=np.array([], dtype=np.float32),
        labels=[],
    )
    with pytest.raises(ValueError, match="empty tree"):
        to_newick(empty)


@pytest.mark.parametrize("tree_id", ["vibrio-upgma", "vibrio-nj", "clostridium-upgma"])
def test_real_trees_round_trip(real_store, tree_id):
    from phylodelta.trees.store import read_tree

    arrays = read_tree(real_store / "trees" / tree_id).to_arrays()
    back = parse_newick(to_newick(arrays))
    assert back.n_leaves == arrays.n_leaves
    assert back.labels == arrays.labels
    np.testing.assert_array_equal(
        np.asarray(back.subtree_end), np.asarray(arrays.subtree_end)
    )


# --- materialisation -------------------------------------------------------

def _pair(tmp_path):
    return MaterialisedPair(
        pair_id="a__b",
        left=parse_newick("((A:1,B:2)x:3,C:4)r;"),
        right=parse_newick("((A:1,C:2)y:3,B:4)r;"),
        directory=tmp_path / "scratch" / "a__b",
    )


def test_materialise_writes_on_demand(tmp_path):
    pair = _pair(tmp_path)
    assert not pair.directory.exists()
    path = pair.newick("left")
    assert path.exists() and path.read_text().endswith(";")


def test_materialise_writes_each_form_once(tmp_path):
    """Two metrics asking for the same form must not serialise it twice."""
    pair = _pair(tmp_path)
    first = pair.newick("left")
    mtime = first.stat().st_mtime_ns
    assert pair.newick("left") is first
    assert first.stat().st_mtime_ns == mtime


def test_weighted_and_topology_forms_are_different_files(tmp_path):
    pair = _pair(tmp_path)
    weighted = pair.newick("left", include_lengths=True)
    bare = pair.newick("left", include_lengths=False)
    assert weighted != bare
    assert ":" in weighted.read_text()
    assert ":" not in bare.read_text()


def test_cleanup_removes_everything_written(tmp_path):
    pair = _pair(tmp_path)
    pair.newick("left")
    pair.newick("right", include_lengths=False)
    pair.cleanup()
    assert not pair.directory.exists()
    pair.cleanup()  # idempotent


def test_context_manager_cleans_up(tmp_path):
    with _pair(tmp_path) as pair:
        path = pair.newick("left")
        assert path.exists()
    assert not path.exists()


def test_unknown_side_is_refused(tmp_path):
    with pytest.raises(ValueError, match="left.*right"):
        _pair(tmp_path).newick("middle")
