"""The endpoints, against a store built from the real datasets."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def compared_client(compared_store, monkeypatch):
    """A client over a store where the pairs have actually been computed."""
    from phylodelta import config, db
    from phylodelta.api.app import create_app
    from phylodelta.metrics import registry_pairs
    from phylodelta.trees import registry

    db.reset()
    monkeypatch.setattr(config, "STORE_DIR", compared_store)
    monkeypatch.setattr(config, "TREES_DIR", compared_store / "trees")
    monkeypatch.setattr(config, "PAIRS_DIR", compared_store / "pairs")
    monkeypatch.setattr(config, "ISOLATES_DIR", compared_store / "isolates")
    registry.reset_cache()
    registry_pairs.reset_cache()
    yield TestClient(create_app())


@pytest.fixture()
def client(real_store, monkeypatch):
    from phylodelta import config, db
    from phylodelta.api import routes_meta
    from phylodelta.api.app import create_app
    from phylodelta.trees import registry

    db.reset()
    monkeypatch.setattr(config, "STORE_DIR", real_store)
    monkeypatch.setattr(config, "TREES_DIR", real_store / "trees")
    monkeypatch.setattr(config, "PAIRS_DIR", real_store / "pairs")
    monkeypatch.setattr(config, "ISOLATES_DIR", real_store / "isolates")
    registry.reset_cache()
    yield TestClient(create_app())
    registry.reset_cache()


def test_health(client):
    body = client.get("/api/v1/health").json()
    assert body["status"] == "ok"
    assert body["store_ready"] is True


def test_datasets_lists_the_ingested_trees(client):
    body = client.get("/api/v1/datasets").json()
    by_id = {t["id"]: t for t in body["trees"]}
    assert set(by_id) == {"vibrio-upgma", "vibrio-nj", "clostridium-upgma"}
    assert by_id["vibrio-upgma"]["n_leaves"] == 17_646
    assert by_id["vibrio-upgma"]["species"] == "vibrio"
    assert by_id["vibrio-upgma"]["method"] == "upgma"


def test_the_listing_shows_comparisons_that_exist(compared_client):
    """What is listed is what has been computed, not what could be.

    This used to enumerate every combination of the owner's trees and offer
    each as an available pair, which was right while the catalogue was the only
    source and wrong as soon as a comparison became something a user creates:
    the id it produced was `sorted(left, right)`, so for an uploaded pair
    stored in upload order a client following it got a 404.
    """
    pairs = {p["id"]: p for p in compared_client.get("/api/v1/datasets").json()["pairs"]}
    assert set(pairs) == {
        "vibrio-nj__vibrio-upgma",
        "clostridium-upgma__vibrio-nj",
        "clostridium-upgma__vibrio-upgma",
    }
    assert all(p["status"] == "ready" for p in pairs.values())


def test_a_listed_pair_reports_what_was_actually_computed(compared_client):
    """The evidence is read back from the result, not re-derived from the trees.

    So the listing cannot disagree with the comparison it points at — and a
    request does not pay for loading every tree's label set to answer it.
    """
    pairs = {p["id"]: p for p in compared_client.get("/api/v1/datasets").json()["pairs"]}
    same = pairs["vibrio-nj__vibrio-upgma"]
    assert same["same_species"] is True
    assert same["caution"] is None
    assert same["species"] == "vibrio"
    assert same["shared_leaves"] == 17_645
    assert same["shared_fraction"] == 1.0
    assert same["metrics"] == ["rf"]


def test_a_cross_species_pair_reports_the_fact_without_the_lecture(compared_client):
    """Not blocked -- whether such a comparison is worth making is the user's
    call, and so is what it implies.

    `same_species` stays false and the overlap is reported, so a reader can see
    exactly what was matched. The prose explaining that sequence types are
    numbered per species was removed (user, 2026-09-24): it restated the
    biologist's own ground on every pair and in every export.
    """
    pairs = {p["id"]: p for p in compared_client.get("/api/v1/datasets").json()["pairs"]}
    cross = pairs["clostridium-upgma__vibrio-upgma"]
    assert cross["same_species"] is False
    assert cross["species"] == "clostridium/vibrio"
    assert cross["shared_leaves"] == 17_490
    assert cross["shared_fraction"] > 0.99
    assert cross["caution"] is None


def test_an_uncomputed_pair_is_not_listed(client):
    """Absent, rather than listed with an empty metric list.

    Two trees that share labels *could* be compared, but there is no way to ask
    for that comparison — uploads arrive as a pair. Advertising it would offer
    a capability that does not exist.
    """
    pairs = {p["id"]: p for p in client.get("/api/v1/datasets").json()["pairs"]}
    assert pairs == {}


def test_openapi_document_is_generated(client):
    doc = client.get("/openapi.json").json()
    assert "/api/v1/datasets" in doc["paths"]


def test_metrics_endpoint_lists_registered_plugins(client):
    body = client.get("/api/v1/metrics").json()
    by_name = {m["name"]: m for m in body}
    assert "rf" in by_name
    assert by_name["rf"]["title"] == "Robinson-Foulds"
    assert by_name["rf"]["capabilities"]["per_clade"] is True


def test_a_pair_appears_once_it_is_computed(client, real_store):
    """Computing a pair is what makes it exist, and the listing follows."""
    from phylodelta.precompute.pipeline import compute_pairs

    pair_id = "vibrio-nj__vibrio-upgma"
    before = {p["id"]: p for p in client.get("/api/v1/datasets").json()["pairs"]}
    assert pair_id not in before

    assert compute_pairs(store_dir=real_store, metrics=["rf"], only=pair_id) == 0
    after = {p["id"]: p for p in client.get("/api/v1/datasets").json()["pairs"]}
    assert after[pair_id]["metrics"] == ["rf"]
    assert after[pair_id]["status"] == "ready"


# --- trees and slicing -----------------------------------------------------

def test_tree_detail(client):
    body = client.get("/api/v1/trees/vibrio-upgma").json()
    assert body["n_leaves"] == 17_646
    assert body["source"] == "vibrio-upgma-tree.nwk"
    assert body["suppressed_unary"] == 0


def test_tree_detail_records_canonicalisation(client):
    """vibrio-nj arrives with a unary root; the header says so (§1.4)."""
    assert client.get("/api/v1/trees/vibrio-nj").json()["suppressed_unary"] == 1


def test_unknown_tree_is_404(client):
    assert client.get("/api/v1/trees/nope").status_code == 404


def test_slice_respects_the_budget_and_loses_nothing(client):
    body = client.get(
        "/api/v1/trees/vibrio-upgma/slice", params={"root": 0, "budget": 50}
    ).json()
    assert body["displayed_leaves"] <= 50
    n = body["nodes"]
    wedges = sum(n["truncated"])
    # Conservation: displayed real leaves + leaves behind wedges = the whole tree.
    assert body["hidden_leaves"] + (body["displayed_leaves"] - wedges) == body["total_leaves"]
    assert body["total_leaves"] == 17_646


def test_slice_arrays_are_all_the_same_length(client):
    n = client.get("/api/v1/trees/vibrio-upgma/slice", params={"budget": 100}).json()["nodes"]
    lengths = {k: len(v) for k, v in n.items()}
    assert len(set(lengths.values())) == 1, lengths


def test_slice_of_a_subtree_is_rooted_there(client):
    top = client.get("/api/v1/trees/vibrio-upgma/slice", params={"budget": 20}).json()
    wedge = next(
        i for i, cut in zip(top["nodes"]["id"], top["nodes"]["truncated"]) if cut
    )
    sub = client.get(
        "/api/v1/trees/vibrio-upgma/slice", params={"root": wedge, "budget": 30}
    ).json()
    assert sub["root"] == wedge
    assert sub["nodes"]["id"][0] == wedge
    assert sub["nodes"]["parent"][0] == -1


def test_slice_rejects_a_root_outside_the_tree(client):
    r = client.get("/api/v1/trees/vibrio-upgma/slice", params={"root": 99_999_999})
    assert r.status_code == 404
    assert r.json()["code"] == "node_out_of_range"


def test_slice_rejects_a_nonsense_budget(client):
    assert client.get("/api/v1/trees/vibrio-upgma/slice", params={"budget": 0}).status_code == 422
    assert client.get("/api/v1/trees/vibrio-upgma/slice", params={"budget": -5}).status_code == 422
    assert client.get(
        "/api/v1/trees/vibrio-upgma/slice", params={"budget": 10_000_000}
    ).status_code == 422


def test_slice_is_fast_enough_to_feel_instant(client):
    """Milestone 3's gate: a slice well under 50 ms."""
    import time

    client.get("/api/v1/trees/vibrio-upgma/slice", params={"budget": 500})  # warm the maps
    started = time.perf_counter()
    for _ in range(5):
        client.get("/api/v1/trees/vibrio-upgma/slice", params={"budget": 500})
    per_call_ms = (time.perf_counter() - started) / 5 * 1000
    assert per_call_ms < 50, f"{per_call_ms:.1f} ms per slice"
