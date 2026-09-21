"""The store must hand back exactly what the parser produced."""

from __future__ import annotations

import json

import numpy as np
import pytest

from phylocmp.trees.newick import parse_newick, parse_newick_file
from phylocmp.trees.normalise import assert_rooted_binary, suppress_unary
from phylocmp.trees.store import COLUMNS, TreeMeta, read_tree, store_bytes, write_tree

#: The gate for milestone 1: leaf counts of the real trees, cross-checked
#: against an independent regex count of the source files.
EXPECTED = {
    "vibrio-upgma": 17_646,
    "vibrio-nj": 17_645,
    "clostridium-upgma": 27_962,
}


def test_round_trip_small(tmp_path):
    arrays = parse_newick("((A:1,B:2)x:3,(C:4,D:5)y:6)root;")
    meta = write_tree(
        tmp_path / "t",
        arrays,
        TreeMeta(
            id="t", species="test", method="upgma", source="inline",
            n_nodes=0, n_leaves=0, max_depth=0,
        ),
    )
    assert meta.n_nodes == arrays.n_nodes
    assert meta.n_leaves == arrays.n_leaves

    back = read_tree(tmp_path / "t").to_arrays()
    for column in COLUMNS:
        np.testing.assert_array_equal(
            np.asarray(getattr(back, column)),
            np.asarray(getattr(arrays, column)),
            err_msg=f"column {column} did not round-trip",
        )
    assert back.labels == arrays.labels


def test_labels_are_addressable_without_reading_them_all(tmp_path):
    arrays = parse_newick("((A,B)x,(C,D)y)root;")
    write_tree(
        tmp_path / "t", arrays,
        TreeMeta(id="t", species="test", method="upgma", source="", n_nodes=0, n_leaves=0, max_depth=0),
    )
    reader = read_tree(tmp_path / "t")
    for i, expected in enumerate(arrays.labels):
        assert reader.label(i) == expected
    assert reader.labels(2, 5) == arrays.labels[2:5]


def test_format_version_mismatch_is_refused(tmp_path):
    arrays = parse_newick("(A,B);")
    write_tree(
        tmp_path / "t", arrays,
        TreeMeta(id="t", species="test", method="upgma", source="", n_nodes=0, n_leaves=0, max_depth=0),
    )
    meta_path = tmp_path / "t" / "meta.json"
    raw = json.loads(meta_path.read_text())
    raw["format_version"] = 999
    meta_path.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="format 999"):
        read_tree(tmp_path / "t")


@pytest.mark.parametrize("tree_id,n_leaves", sorted(EXPECTED.items()))
def test_real_trees_round_trip(real_store, datasets_dir, tree_id, n_leaves):
    reader = read_tree(real_store / "trees" / tree_id)
    assert reader.meta.n_leaves == n_leaves

    source = next(datasets_dir.glob(f"gen_trees/{reader.meta.source}"))
    # Re-derive through the same canonicalisation the pipeline applies; the
    # store holds the normalised tree, not the raw file's node numbering.
    fresh, suppressed = suppress_unary(parse_newick_file(source))
    assert suppressed == reader.meta.suppressed_unary
    stored = reader.to_arrays()
    for column in COLUMNS:
        np.testing.assert_array_equal(
            np.asarray(getattr(stored, column)), np.asarray(getattr(fresh, column))
        )
    assert stored.labels == fresh.labels


def test_real_trees_are_binary_and_rooted(real_store):
    """The scope assumption, asserted rather than trusted.

    goeBURST forests violate both halves of this, which is why they are out of
    scope; if a dataset ever slipped in, this fails loudly instead of producing
    quietly wrong comparisons.
    """
    for tree_id in EXPECTED:
        arrays = read_tree(real_store / "trees" / tree_id).to_arrays()
        assert_rooted_binary(arrays)
        assert arrays.n_nodes == 2 * arrays.n_leaves - 1, tree_id


def test_storage_cost_per_node(real_store):
    """Recorded as evidence: the store is ~25 B/node, so size is not the problem."""
    for tree_id in EXPECTED:
        directory = real_store / "trees" / tree_id
        reader = read_tree(directory)
        per_node = store_bytes(directory) / reader.meta.n_nodes
        assert 20 < per_node < 32, f"{tree_id}: {per_node:.1f} B/node"
