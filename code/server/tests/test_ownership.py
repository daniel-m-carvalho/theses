"""Ownership, and the seam that decides who is asking.

Two things are being established here, neither of which existed before: that a
dataset belongs to someone, and that the question "who is this request for" has
exactly one answer-site. The identity *source* is undecided (DECISIONS.md
§19.5); everything here is true whichever way that goes.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from phylodelta import config, db


@pytest.fixture()
def store(tmp_path, monkeypatch):
    db.reset()
    monkeypatch.setattr(config, "STORE_DIR", tmp_path)
    monkeypatch.setattr(config, "TREES_DIR", tmp_path / "trees")
    monkeypatch.setattr(config, "PAIRS_DIR", tmp_path / "pairs")
    monkeypatch.setattr(config, "ISOLATES_DIR", tmp_path / "isolates")
    db.create_schema()
    yield tmp_path
    db.reset()


def add(owner: str, dataset_id: str, kind=db.DatasetKind.TREE) -> None:
    db.register_dataset(
        dataset_id=dataset_id, owner_id=owner, kind=kind,
        display_name=dataset_id, store_path=f"trees/{dataset_id}",
    )


# --- the model -------------------------------------------------------------

def test_a_dataset_belongs_to_one_owner(store):
    add("alice", "t1")
    assert [d.id for d in db.datasets_for("alice")] == ["t1"]
    assert db.datasets_for("bob") == []


def test_owners_are_isolated(store):
    add("alice", "a1")
    add("bob", "b1")
    assert [d.id for d in db.datasets_for("alice")] == ["a1"]
    assert [d.id for d in db.datasets_for("bob")] == ["b1"]


def test_another_owners_dataset_is_indistinguishable_from_a_missing_one(store):
    """So an id cannot be probed for existence by someone who does not own it."""
    add("alice", "secret")
    assert db.dataset_for("alice", "secret") is not None
    assert db.dataset_for("bob", "secret") is None
    assert db.dataset_for("bob", "never-existed") is None


def test_registration_is_idempotent(store):
    """`build-all` is re-runnable; it must not accumulate duplicates."""
    add("alice", "t1")
    add("alice", "t1")
    assert len(db.datasets_for("alice")) == 1


def test_the_store_path_never_names_the_owner(store):
    """What keeps sharing a new table rather than a data migration (§19.6)."""
    add("alice", "t1")
    record = db.dataset_for("alice", "t1")
    assert "alice" not in record.store_path


def test_kinds_are_separable(store):
    add("alice", "t1", db.DatasetKind.TREE)
    add("alice", "i1", db.DatasetKind.ISOLATES)
    assert [d.id for d in db.datasets_for("alice", db.DatasetKind.TREE)] == ["t1"]
    assert [d.id for d in db.datasets_for("alice", db.DatasetKind.ISOLATES)] == ["i1"]


# --- the database follows the store ----------------------------------------

def test_the_database_lives_beside_the_store_it_describes(store):
    """Ownership rows are meaningless against a different set of stores.

    Before engines were cached by URL, ingesting into a temporary store wrote
    its ownership rows into the configured one — so a test run could write to a
    developer's real database, and tests passed by reading ids that happened to
    match.
    """
    assert str(store) in db.database_url()
    add("alice", "t1")
    assert (store / "phylodelta.sqlite").exists()


def test_pointing_at_another_store_yields_another_database(store, tmp_path):
    add("alice", "here")
    other = tmp_path / "elsewhere"
    with db.using_store(other):
        db.create_schema()
        assert db.datasets_for("alice") == [], "must not see the other store's rows"
        add("alice", "there")
    assert [d.id for d in db.datasets_for("alice")] == ["here"]


# --- the identity seam -----------------------------------------------------

def client_for(monkeypatch, auth: str) -> TestClient:
    from phylodelta.api.app import create_app

    monkeypatch.setenv("PHYLODELTA_AUTH", auth)
    return TestClient(create_app())


def test_without_auth_everything_belongs_to_one_owner(store, monkeypatch):
    from phylodelta.api.identity import SINGLE_OWNER

    client = client_for(monkeypatch, "none")
    assert client.get("/api/v1/datasets").status_code == 200
    add(SINGLE_OWNER, "t1")
    assert [d.id for d in db.datasets_for(SINGLE_OWNER)] == ["t1"]


def test_header_mode_separates_owners(store, monkeypatch):
    add("alice", "a1")
    add("bob", "b1")
    client = client_for(monkeypatch, "header")

    alice = client.get("/api/v1/datasets", headers={"X-PhyloDelta-Owner": "alice"})
    bob = client.get("/api/v1/datasets", headers={"X-PhyloDelta-Owner": "bob"})
    # The stores do not exist, so neither lists a tree — but each asked a
    # different question, and neither errored.
    assert alice.status_code == bob.status_code == 200


def test_header_mode_requires_the_header(store, monkeypatch):
    response = client_for(monkeypatch, "header").get("/api/v1/datasets")
    assert response.status_code == 401
    assert response.json()["code"] == "owner_required"


def test_token_mode_refuses_rather_than_pretending(store, monkeypatch):
    """A verifier that does not verify would look like security."""
    response = client_for(monkeypatch, "token").get("/api/v1/datasets")
    assert response.status_code == 501
    assert response.json()["code"] == "auth_not_implemented"


def test_a_misconfigured_mode_fails_loudly(store, monkeypatch):
    response = client_for(monkeypatch, "sometimes").get("/api/v1/datasets")
    assert response.status_code == 500
    assert response.json()["code"] == "auth_misconfigured"


# --- the listing is owner-scoped end to end --------------------------------

def test_datasets_lists_only_your_trees(real_store, monkeypatch):
    from phylodelta.api.app import create_app

    db.reset()
    monkeypatch.setattr(config, "STORE_DIR", real_store)
    monkeypatch.setattr(config, "TREES_DIR", real_store / "trees")
    monkeypatch.setattr(config, "PAIRS_DIR", real_store / "pairs")
    monkeypatch.setattr(config, "ISOLATES_DIR", real_store / "isolates")
    monkeypatch.setenv("PHYLODELTA_AUTH", "header")
    from phylodelta.trees import registry

    registry.reset_cache()
    client = TestClient(create_app())

    mine = client.get("/api/v1/datasets", headers={"X-PhyloDelta-Owner": "local"}).json()
    assert {t["id"] for t in mine["trees"]} == {
        "vibrio-upgma", "vibrio-nj", "clostridium-upgma"
    }

    theirs = client.get(
        "/api/v1/datasets", headers={"X-PhyloDelta-Owner": "stranger"}
    ).json()
    assert theirs["trees"] == []
    assert theirs["pairs"] == []
    registry.reset_cache()
    db.reset()
