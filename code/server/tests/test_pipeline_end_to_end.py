"""The whole pipeline, on a committed fixture dataset.

Every other test needs `datasets/` — the real 20 MB of EnteroBase exports — and
skips without it. This one does not: the fixture in `tests/fixtures/datasets`
is 6 KB and lives in the repository, so the suite proves the pipeline works
anywhere, including on a machine that has only ever cloned the code.

The fixture deliberately reproduces the awkward shapes found in the real data,
because those are what broke things:

* a tree with a **unary root** (vibrio-nj's shape, §1.4 — it crashes the
  reference implementation)
* **mismatched leaf sets**, one tree missing a leaf the other has (ST 211, §3.1)
* **sequence types with no isolates**, and isolates whose ST is in no tree (§7.5)
* **blank cells** in every isolate column (§7.5)
* a **goeBURST file**, which the catalogue must skip (§1.8)
* a **constant column**, which facet selection must drop (§7.4)
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

FIXTURES = Path(__file__).parent / "fixtures" / "datasets"
PAIR = "mini-nj__mini-upgma"


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """Run all three offline stages, exactly as the CLI does."""
    from phylocmp.isolates.ingest import ingest_all
    from phylocmp.precompute.pipeline import compute_pairs, ingest_trees

    store = tmp_path_factory.mktemp("mini")
    assert ingest_trees(datasets_dir=FIXTURES, store_dir=store) == 0
    assert compute_pairs(store_dir=store, metrics=["rf"]) == 0
    assert ingest_all(datasets_dir=FIXTURES, store_dir=store) == 0
    return store


@pytest.fixture()
def client(built, monkeypatch):
    from phylocmp import config
    from phylocmp.api.app import create_app
    from phylocmp.isolates import registry as isolate_registry
    from phylocmp.metrics import registry_pairs
    from phylocmp.trees import registry as tree_registry

    monkeypatch.setattr(config, "STORE_DIR", built)
    monkeypatch.setattr(config, "TREES_DIR", built / "trees")
    monkeypatch.setattr(config, "PAIRS_DIR", built / "pairs")
    monkeypatch.setattr(config, "ISOLATES_DIR", built / "isolates")
    for registry in (tree_registry, registry_pairs, isolate_registry):
        registry.reset_cache()
    yield TestClient(create_app())
    for registry in (tree_registry, registry_pairs, isolate_registry):
        registry.reset_cache()


def test_health_reports_a_ready_store(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["store_ready"] is True


def test_goeburst_is_not_ingested(client):
    ids = {t["id"] for t in client.get("/api/datasets").json()["trees"]}
    assert ids == {"mini-upgma", "mini-nj"}


def test_the_unary_root_was_canonicalised(client):
    """The fixture's nj tree wraps its real root, as vibrio-nj's does."""
    assert client.get("/api/trees/mini-nj").json()["suppressed_unary"] == 1
    assert client.get("/api/trees/mini-upgma").json()["suppressed_unary"] == 0


def test_mismatched_leaf_sets_are_reconciled_and_reported(client):
    body = client.get(f"/api/comparisons/{PAIR}").json()
    assert body["shared_leaves"] == 39
    assert body["dropped_from_right"] == ["7"]
    assert body["dropped_from_left"] == []


def test_a_tree_compared_with_itself_would_score_zero(built):
    from phylocmp.metrics.plugins.rf_python.rf import compute
    from phylocmp.trees.correspondence import compute_correspondence
    from phylocmp.trees.store import read_tree

    arrays = read_tree(built / "trees" / "mini-upgma").to_arrays()
    correspondence = compute_correspondence(arrays, arrays, best_match=False)
    assert compute(arrays, arrays, correspondence).summary["rf"] == 0


def test_slice_conserves_every_leaf(client):
    for budget in (1, 2, 5, 40, 500):
        body = client.get(
            "/api/trees/mini-upgma/slice", params={"budget": budget}
        ).json()
        wedges = sum(body["nodes"]["truncated"])
        assert body["displayed_leaves"] <= budget
        assert (
            body["displayed_leaves"] - wedges + body["hidden_leaves"]
            == body["total_leaves"] == 40
        )


def test_slice_and_comparison_align(client):
    body = client.get(
        "/api/trees/mini-nj/slice", params={"budget": 20, "compare": PAIR}
    ).json()
    assert body["comparison"]["id"] == body["nodes"]["id"]
    separate = client.get(
        f"/api/comparisons/{PAIR}/slice", params={"tree": "mini-nj", "budget": 20}
    ).json()
    assert separate["nodes"] == body["comparison"]


def test_both_orderings_work(client):
    for order in ("size", "difference"):
        body = client.get(
            "/api/trees/mini-nj/slice",
            params={"budget": 15, "compare": PAIR, "order": order},
        ).json()
        assert body["displayed_leaves"] <= 15


def test_constant_column_is_not_a_facet(client):
    names = {f["name"] for f in client.get("/api/isolates/mini/keys").json()["facets"]}
    assert "Differences" not in names, "one distinct value: cannot divide anything"
    assert "Barcode" not in names and "Uberstrain" not in names
    assert {"Source Niche", "Country", "Continent"} <= names


def test_compositions_distinguish_no_data_from_filtered_out(client):
    body = client.post(
        "/api/isolates/mini/compositions",
        json={"leaves": [str(i) for i in range(1, 41)], "segment_by": "Country"},
    ).json()
    assert len(body["leaves"]) == 40
    # The fixture gives some STs no isolates at all; that must be visible.
    assert any(leaf["available"] == 0 for leaf in body["leaves"])
    assert all(leaf["total"] <= leaf["available"] for leaf in body["leaves"])


def test_errors_share_one_shape(client):
    for request, expected in (
        (("GET", "/api/trees/nope"), "tree_not_found"),
        (("GET", "/api/trees/mini-upgma/slice?root=99999"), "node_out_of_range"),
        (("GET", "/api/isolates/nope/keys"), "isolates_not_found"),
    ):
        method, url = request
        response = client.request(method, url)
        body = response.json()
        assert response.status_code == 404
        assert body["code"] == expected
        assert isinstance(body["detail"], str) and body["detail"]


def test_invalid_parameters_use_the_same_error_shape(client):
    body = client.get("/api/trees/mini-upgma/slice", params={"budget": 0}).json()
    assert body["code"] == "invalid_request"
    assert "budget" in body["detail"]
    assert body["errors"][0]["field"] == "budget"
