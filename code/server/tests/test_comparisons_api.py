"""Serving comparisons, and the alignment that makes them usable.

Milestone 4's gate: values arrive in the same order as the topology they
describe, index for index.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

PAIR = "vibrio-nj__vibrio-upgma"


@pytest.fixture(scope="module")
def computed_store(tmp_path_factory):
    """A store with trees ingested and the vibrio pair computed."""
    from pathlib import Path

    from phylodelta.precompute.pipeline import compute_pairs, ingest_trees

    datasets = Path(__file__).resolve().parents[3] / "datasets"
    if not datasets.is_dir():
        pytest.skip("datasets not present")
    store = tmp_path_factory.mktemp("computed")
    assert ingest_trees(datasets_dir=datasets, store_dir=store) == 0
    assert compute_pairs(store_dir=store, metrics=["rf"], only=PAIR) == 0
    return store


@pytest.fixture()
def client(computed_store, monkeypatch):
    from phylodelta import config, db
    from phylodelta.api.app import create_app
    from phylodelta.metrics import registry_pairs
    from phylodelta.trees import registry

    db.reset()
    monkeypatch.setattr(config, "STORE_DIR", computed_store)
    monkeypatch.setattr(config, "TREES_DIR", computed_store / "trees")
    monkeypatch.setattr(config, "PAIRS_DIR", computed_store / "pairs")
    monkeypatch.setattr(config, "ISOLATES_DIR", computed_store / "isolates")
    registry.reset_cache()
    registry_pairs.reset_cache()
    yield TestClient(create_app())
    registry.reset_cache()
    registry_pairs.reset_cache()


# --- summary ---------------------------------------------------------------

def test_summary_carries_scalars_and_provenance(client):
    body = client.get(f"/api/v1/comparisons/{PAIR}").json()
    assert body["summary"]["rf"] == 6825
    assert body["summary"]["shared_clusters"] == 10_819
    assert body["shared_leaves"] == 17_645
    assert body["dropped_from_right"] == ["211"]
    assert body["same_species"] is True
    assert body["caution"] is None
    assert body["values"] is None, "whole-tree values must be opt-in"


def test_whole_tree_values_are_opt_in(client):
    body = client.get(f"/api/v1/comparisons/{PAIR}", params={"include_values": True}).json()
    assert len(body["values"]["id"]) == 35_289  # every node of the left tree


def test_unknown_pair_explains_how_to_compute_it(client):
    r = client.get("/api/v1/comparisons/clostridium-upgma__vibrio-upgma")
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == "comparison_not_computed"
    assert "compute-pairs" in body["hint"]


def test_unknown_metric_names_what_is_available(client):
    r = client.get(f"/api/v1/comparisons/{PAIR}", params={"metric": "quartet"})
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == "metric_not_computed"
    assert "rf" in body["hint"]


# --- the alignment gate ----------------------------------------------------

@pytest.mark.parametrize("budget", [5, 50, 300])
def test_comparison_slice_matches_the_tree_slice_index_for_index(client, budget):
    tree = client.get(
        "/api/v1/trees/vibrio-nj/slice", params={"root": 0, "budget": budget}
    ).json()
    values = client.get(
        f"/api/v1/comparisons/{PAIR}/slice",
        params={"tree": "vibrio-nj", "root": 0, "budget": budget},
    ).json()
    assert values["nodes"]["id"] == tree["nodes"]["id"]
    assert len(values["nodes"]["similarity"]) == len(tree["nodes"]["id"])


def test_one_round_trip_matches_two(client):
    """?compare= must give exactly what the separate endpoint gives."""
    combined = client.get(
        "/api/v1/trees/vibrio-nj/slice", params={"budget": 100, "compare": PAIR}
    ).json()
    separate = client.get(
        f"/api/v1/comparisons/{PAIR}/slice", params={"tree": "vibrio-nj", "budget": 100}
    ).json()
    assert combined["comparison"] == separate["nodes"]


def test_values_describe_the_node_they_sit_beside(client):
    """A displayed leaf's counterpart must carry the same label."""
    combined = client.get(
        "/api/v1/trees/vibrio-nj/slice", params={"budget": 200, "compare": PAIR}
    ).json()
    other = client.get("/api/v1/trees/vibrio-upgma").json()["id"]
    n, v = combined["nodes"], combined["comparison"]
    assert v["id"] == n["id"]

    checked = 0
    for k in range(len(n["id"])):
        is_leaf = not n["truncated"][k] and n["true_leaf_count"][k] == 1
        if not is_leaf or v["corresponds"][k] is None:
            continue
        counterpart = client.get(
            f"/api/v1/trees/{other}/slice",
            params={"root": v["corresponds"][k], "budget": 1},
        ).json()
        assert counterpart["nodes"]["label"][0] == n["label"][k]
        checked += 1
        if checked >= 5:
            break
    assert checked > 0


def test_similarity_agrees_with_the_exact_verdict(client):
    body = client.get(
        "/api/v1/trees/vibrio-nj/slice", params={"budget": 400, "compare": PAIR}
    ).json()["comparison"]
    for sim, exact in zip(body["similarity"], body["exact"]):
        if sim is None:
            continue
        assert (sim == 1.0) == exact


# --- JSON hygiene ----------------------------------------------------------

def test_absent_values_are_null_not_nan(client):
    """JSON has no NaN; emitting one produces a document many parsers reject."""
    raw = client.get(
        "/api/v1/trees/vibrio-upgma/slice", params={"budget": 500, "compare": PAIR}
    ).content
    assert b"NaN" not in raw
    json.loads(raw)  # strict: would raise on a bare NaN


def test_a_leaf_unique_to_one_tree_has_no_counterpart(client):
    """What an equal/different leaf colouring keys off.

    ST 211 exists only in vibrio-upgma, so it was excluded when the leaf sets
    were reconciled. It is still served — a leaf present in one tree only is a
    real thing to show — but with no similarity and no counterpart.
    """
    whole = client.get(
        "/api/v1/trees/vibrio-upgma/slice",
        params={"root": 0, "budget": 50_000, "compare": PAIR},
    ).json()
    n, v = whole["nodes"], whole["comparison"]
    assert n["id"] == v["id"]

    position = n["label"].index("211")
    assert v["similarity"][position] is None
    assert v["corresponds"][position] is None
    assert v["exact"][position] is False

    # Every other displayed leaf does have a counterpart.
    unmatched = [
        k for k in range(len(n["id"]))
        if n["true_leaf_count"][k] == 1 and not n["truncated"][k]
        and v["corresponds"][k] is None
    ]
    assert [n["label"][k] for k in unmatched] == ["211"]


# --- routing -----------------------------------------------------------------

def test_asking_for_a_tree_outside_the_pair_is_refused(client):
    r = client.get(
        f"/api/v1/comparisons/{PAIR}/slice", params={"tree": "clostridium-upgma"}
    )
    assert r.status_code == 400
    assert r.json()["code"] == "tree_not_in_pair"


def test_compare_with_an_uncomputed_pair_is_404(client):
    r = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"budget": 10, "compare": "clostridium-upgma__vibrio-nj"},
    )
    assert r.status_code == 404


def test_slice_at_a_subtree_carries_its_own_values(client):
    top = client.get(
        "/api/v1/trees/vibrio-nj/slice", params={"budget": 20, "compare": PAIR}
    ).json()
    wedge = next(i for i, c in zip(top["nodes"]["id"], top["nodes"]["truncated"]) if c)
    sub = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"root": wedge, "budget": 40, "compare": PAIR},
    ).json()
    assert sub["nodes"]["id"][0] == wedge
    assert sub["comparison"]["id"][0] == wedge
    assert len(sub["comparison"]["similarity"]) == len(sub["nodes"]["id"])


# --- ordering ---------------------------------------------------------------

def test_difference_ordering_surfaces_more_divergent_clades(client):
    """order=difference must land on changes that order=size misses."""
    def worst_similarity(order):
        body = client.get(
            "/api/v1/trees/vibrio-nj/slice",
            params={"budget": 100, "compare": PAIR, "order": order},
        ).json()
        vals = [s for s in body["comparison"]["similarity"] if s is not None]
        return min(vals)

    assert worst_similarity("difference") < worst_similarity("size")


def test_ordering_preserves_the_conservation_invariant(client):
    """Priority decides where detail goes; it must never lose a leaf."""
    for order in ("size", "difference"):
        body = client.get(
            "/api/v1/trees/vibrio-nj/slice",
            params={"budget": 150, "compare": PAIR, "order": order},
        ).json()
        wedges = sum(body["nodes"]["truncated"])
        assert (
            body["displayed_leaves"] - wedges + body["hidden_leaves"]
            == body["total_leaves"]
        )
        assert body["displayed_leaves"] <= 150


def test_both_endpoints_agree_under_difference_ordering(client):
    """The alignment gate must hold for every ordering, not just the default."""
    tree = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"budget": 120, "compare": PAIR, "order": "difference"},
    ).json()
    values = client.get(
        f"/api/v1/comparisons/{PAIR}/slice",
        params={"tree": "vibrio-nj", "budget": 120, "order": "difference"},
    ).json()
    assert values["nodes"]["id"] == tree["nodes"]["id"]
    assert values["nodes"] == tree["comparison"]


def test_difference_ordering_changes_the_node_set(client):
    a = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"budget": 100, "compare": PAIR, "order": "size"},
    ).json()["nodes"]["id"]
    b = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"budget": 100, "compare": PAIR, "order": "difference"},
    ).json()["nodes"]["id"]
    assert a != b, "the two orderings should not produce the same slice"


def test_difference_without_a_comparison_is_refused(client):
    r = client.get(
        "/api/v1/trees/vibrio-nj/slice", params={"budget": 10, "order": "difference"}
    )
    assert r.status_code == 400
    assert r.json()["code"] == "order_needs_comparison"


def test_unknown_order_is_rejected(client):
    r = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"budget": 10, "compare": PAIR, "order": "sideways"},
    )
    assert r.status_code == 422


# --- a metric that contributes nothing per node ----------------------------

def test_a_scalar_only_metric_is_served_with_the_full_gradient(client, computed_store):
    """The geodesic case, end to end.

    A metric may be a single number over branch lengths with no per-clade
    meaning. It must still be usable: branch and leaf colouring come from the
    pair's correspondence, not from the metric, so the only thing missing is
    that metric's own overlay.
    """
    from phylodelta.metrics.contract import MetricResult
    from phylodelta.metrics.registry_pairs import reset_cache
    from phylodelta.metrics.store import write_pair
    from phylodelta.trees.store import read_tree

    left = read_tree(computed_store / "trees" / "vibrio-nj").to_arrays()
    right = read_tree(computed_store / "trees" / "vibrio-upgma").to_arrays()
    write_pair(
        computed_store / "pairs" / PAIR / "demo-scalar",
        MetricResult(name="demo-scalar", summary={"distance": 12.5}),
        PAIR, "vibrio-nj", "vibrio-upgma", left, right,
    )
    reset_cache()

    summary = client.get(
        f"/api/v1/comparisons/{PAIR}", params={"metric": "demo-scalar"}
    ).json()
    assert summary["summary"]["distance"] == 12.5

    body = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"budget": 50, "compare": PAIR, "metric": "demo-scalar"},
    ).json()
    values = body["comparison"]
    assert values["id"] == body["nodes"]["id"]
    # The gradient is there, because it never came from the metric.
    assert any(s is not None for s in values["similarity"])
    assert any(c is not None for c in values["corresponds"])
    # The metric's own layers are simply absent, not faked.
    assert values["exact"] == []
    assert values["columns"] == {}


def test_difference_ordering_works_for_a_scalar_only_metric(client, computed_store):
    """order=difference ranks by correspondence, so it does not need the metric."""
    from phylodelta.metrics.contract import MetricResult
    from phylodelta.metrics.registry_pairs import reset_cache
    from phylodelta.metrics.store import write_pair
    from phylodelta.trees.store import read_tree

    left = read_tree(computed_store / "trees" / "vibrio-nj").to_arrays()
    right = read_tree(computed_store / "trees" / "vibrio-upgma").to_arrays()
    write_pair(
        computed_store / "pairs" / PAIR / "demo-scalar2",
        MetricResult(name="demo-scalar2", summary={"distance": 1.0}),
        PAIR, "vibrio-nj", "vibrio-upgma", left, right,
    )
    reset_cache()

    body = client.get(
        "/api/v1/trees/vibrio-nj/slice",
        params={"budget": 100, "compare": PAIR, "metric": "demo-scalar2",
                "order": "difference"},
    ).json()
    sims = [s for s in body["comparison"]["similarity"] if s is not None]
    assert min(sims) < 0.1, "should still have descended toward the differences"


def test_metrics_endpoint_describes_what_a_column_means(client):
    """Enough for a client to render a column it has never seen."""
    rf = {m["name"]: m for m in client.get("/api/v1/metrics").json()}["rf"]
    exact = {c["name"]: c for c in rf["outputs"]["columns"]}["exact"]
    assert exact["semantics"] == "boolean"
    assert exact["render"] == "overlay"
    assert exact["label"] and exact["description"]
    assert {s["key"] for s in rf["outputs"]["summary"]} >= {"rf", "rf_normalised"}
