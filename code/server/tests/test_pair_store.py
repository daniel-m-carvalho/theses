"""Storing a comparison: correspondence, a metric's columns, and projection.

Projection is where a silent off-by-one would do the most damage — the values
would still look plausible, just attached to the wrong clades. Dropping one leaf
from a 17,646-leaf tree shifts every index after it.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from phylodelta.metrics.contract import MetricResult, MetricSide
from phylodelta.metrics.plugins.rf_python.rf import compute
from phylodelta.metrics.project import project, project_correspondence
from phylodelta.metrics.store import (
    read_correspondence,
    read_pair,
    write_correspondence,
    write_pair,
)
from phylodelta.trees.correspondence import NO_CORRESPONDENCE, compute_correspondence
from phylodelta.trees.newick import parse_newick
from phylodelta.trees.reconcile import reconcile


def prepared(a, b):
    """Everything the pipeline computes for a pair, projected onto the stored trees."""
    left_r, right_r, report = reconcile(a, b)
    correspondence = compute_correspondence(left_r, right_r)
    result = compute(left_r, right_r, correspondence)
    return (
        project_correspondence(
            correspondence,
            report.left_source_index, report.right_source_index,
            a.n_nodes, b.n_nodes,
        ),
        project(
            result,
            report.left_source_index, report.right_source_index,
            a.n_nodes, b.n_nodes,
        ),
    )


# --- projection ------------------------------------------------------------

def test_projection_is_the_identity_when_nothing_was_dropped():
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    direct = compute_correspondence(a, b)
    corr, _ = prepared(a, b)
    np.testing.assert_allclose(corr.left.similarity, direct.left.similarity)
    np.testing.assert_array_equal(corr.left.corresponds, direct.left.corresponds)


def test_dropped_nodes_have_no_value_rather_than_a_wrong_one():
    a = parse_newick("(((A,B),X),(C,D));")   # X is unique to a
    b = parse_newick("((A,C),(B,D));")
    corr, result = prepared(a, b)
    missing = np.flatnonzero(np.isnan(corr.left.similarity))
    # X itself, and the parent it leaves unary.
    assert sorted(a.labels[i] for i in missing) == ["", "X"]
    assert (corr.left.corresponds[missing] == NO_CORRESPONDENCE).all()
    assert not result.left.columns["exact"][missing].any()


def test_projection_keeps_leaves_pointing_at_their_own_label():
    """The alignment check that would fail on any index shift."""
    a = parse_newick("(((A,B),X),(C,D));")
    b = parse_newick("((A,C),(B,D));")
    corr, _ = prepared(a, b)
    end = np.asarray(a.subtree_end)
    for i in range(a.n_nodes):
        if end[i] != i + 1 or a.labels[i] == "X":
            continue
        assert b.labels[int(corr.left.corresponds[i])] == a.labels[i]


# --- the two stores --------------------------------------------------------

def test_correspondence_round_trips(tmp_path):
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    corr, _ = prepared(a, b)
    write_correspondence(tmp_path / "c", corr, "a__b", "a", "b", a, b)

    back = read_correspondence(tmp_path / "c")
    assert back.meta.left == "a" and back.meta.right == "b"
    np.testing.assert_allclose(
        np.asarray(back.column("left", "similarity")), corr.left.similarity
    )
    np.testing.assert_array_equal(
        np.asarray(back.column("left", "corresponds")), corr.left.corresponds
    )


def test_metric_columns_round_trip(tmp_path):
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    _, result = prepared(a, b)
    meta = write_pair(tmp_path / "p", result, "a__b", "a", "b", a, b)
    assert meta.summary["rf"] == 1

    back = read_pair(tmp_path / "p")
    assert back.columns("left") == ["exact"]
    np.testing.assert_array_equal(
        np.asarray(back.column("left", "exact")).astype(bool),
        result.left.columns["exact"],
    )


def test_a_metric_with_no_columns_is_storable(tmp_path):
    """The geodesic case: a single number, nothing per node, still a valid result."""
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    scalar_only = MetricResult(name="geodesic", summary={"geodesic": 1.75})

    meta = write_pair(tmp_path / "g", scalar_only, "a__b", "a", "b", a, b)
    assert meta.summary["geodesic"] == 1.75

    back = read_pair(tmp_path / "g")
    assert back.columns("left") == []
    assert back.slice("left", 0, 3) == {}


def test_an_empty_metric_side_is_also_storable(tmp_path):
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    empty = MetricResult(
        name="scalarish", summary={"x": 1},
        left=MetricSide(columns={}), right=MetricSide(columns={}),
    )
    write_pair(tmp_path / "e", empty, "a__b", "a", "b", a, b)
    assert read_pair(tmp_path / "e").columns("left") == []


def test_a_metric_may_declare_several_columns(tmp_path):
    """Nothing caps a metric at one column; a richer metric is not flattened."""
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    rich = MetricResult(
        name="rich", summary={"score": 2},
        left=MetricSide(columns={
            "exact": np.array([1, 0, 1, 1, 0], dtype=np.uint8),
            "agreement": np.array([0.5, 0.25, 1.0, 1.0, 0.0], dtype=np.float32),
        }),
        right=MetricSide(columns={
            "exact": np.array([1, 0, 1, 1, 0], dtype=np.uint8),
            "agreement": np.array([0.1, 0.2, 0.3, 0.4, 0.5], dtype=np.float32),
        }),
    )
    write_pair(tmp_path / "r", rich, "a__b", "a", "b", a, b)
    back = read_pair(tmp_path / "r")
    assert back.columns("left") == ["agreement", "exact"]
    np.testing.assert_allclose(
        np.asarray(back.column("left", "agreement")), [0.5, 0.25, 1.0, 1.0, 0.0]
    )


def test_columns_of_the_wrong_length_are_refused(tmp_path):
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    wrong = MetricResult(
        name="wrong", summary={},
        left=MetricSide(columns={"exact": np.zeros(3, dtype=np.uint8)}),
        right=MetricSide(columns={"exact": np.zeros(5, dtype=np.uint8)}),
    )
    with pytest.raises(ValueError, match="covers 3 nodes"):
        write_pair(tmp_path / "w", wrong, "a__b", "a", "b", a, b)


def test_slice_uses_the_same_range_as_the_topology(tmp_path):
    a = parse_newick("(((A,B),C),(D,(E,F)));")
    b = parse_newick("((A,(B,C)),((D,E),F));")
    corr, result = prepared(a, b)
    write_correspondence(tmp_path / "c", corr, "a__b", "a", "b", a, b)
    write_pair(tmp_path / "p", result, "a__b", "a", "b", a, b)

    start, end = 1, int(a.subtree_end[1])
    got = read_correspondence(tmp_path / "c").slice("left", start, end)
    np.testing.assert_allclose(got["similarity"], corr.left.similarity[start:end])
    got_metric = read_pair(tmp_path / "p").slice("left", start, end)
    np.testing.assert_array_equal(
        got_metric["exact"].astype(bool), result.left.columns["exact"][start:end]
    )


@pytest.mark.parametrize("directory,reader", [("c", "correspondence"), ("p", "pair")])
def test_format_version_mismatch_is_refused(tmp_path, directory, reader):
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    corr, result = prepared(a, b)
    if directory == "c":
        write_correspondence(tmp_path / directory, corr, "a__b", "a", "b", a, b)
        read = read_correspondence
    else:
        write_pair(tmp_path / directory, result, "a__b", "a", "b", a, b)
        read = read_pair

    meta = tmp_path / directory / "meta.json"
    raw = json.loads(meta.read_text())
    raw["format_version"] = 99
    meta.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="format 99"):
        read(tmp_path / directory)


def test_unknown_column_names_what_is_there(tmp_path):
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    _, result = prepared(a, b)
    write_pair(tmp_path / "p", result, "a__b", "a", "b", a, b)
    with pytest.raises(KeyError, match="exact"):
        read_pair(tmp_path / "p").column("left", "nonexistent")


# --- the real pair ---------------------------------------------------------

def test_real_pair_end_to_end(real_store, tmp_path):
    """The full pipeline on real data, with the alignment assertion that matters."""
    from phylodelta.trees.store import read_tree

    left = read_tree(real_store / "trees" / "vibrio-nj").to_arrays()
    right = read_tree(real_store / "trees" / "vibrio-upgma").to_arrays()
    left_r, right_r, report = reconcile(left, right)
    correspondence = compute_correspondence(left_r, right_r, best_match=False)
    result = compute(left_r, right_r, correspondence)

    corr = project_correspondence(
        correspondence, report.left_source_index, report.right_source_index,
        left.n_nodes, right.n_nodes,
    )
    result = project(
        result, report.left_source_index, report.right_source_index,
        left.n_nodes, right.n_nodes,
    )
    write_correspondence(tmp_path / "c", corr, "pair", "vibrio-nj", "vibrio-upgma", left, right)
    write_pair(tmp_path / "p", result, "pair", "vibrio-nj", "vibrio-upgma", left, right)

    assert read_pair(tmp_path / "p").meta.summary["rf"] == 6825
    back = read_correspondence(tmp_path / "c")
    # Exactly two right-tree nodes have no counterpart: ST 211 and the internal
    # node it leaves unary.
    assert int(np.isnan(np.asarray(back.column("right", "similarity"))).sum()) == 2
    assert int(np.isnan(np.asarray(back.column("left", "similarity"))).sum()) == 0

    corr_left = np.asarray(back.column("left", "corresponds"))
    end = np.asarray(left.subtree_end)
    leaves = np.flatnonzero(end == np.arange(left.n_nodes) + 1)
    mismatched = sum(
        1 for i in leaves if right.labels[int(corr_left[i])] != left.labels[int(i)]
    )
    assert mismatched == 0, "a leaf's counterpart must carry the same label"
