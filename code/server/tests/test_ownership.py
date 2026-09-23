"""Ownership, and the seam that decides who is asking.

Two things are being established here, neither of which existed before: that a
dataset belongs to someone, and that the question "who is this request for" has
exactly one answer-site. The identity *source* is undecided (DECISIONS.md
§19.5); everything here is true whichever way that goes.
"""

from __future__ import annotations

import re

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


def test_a_misconfigured_mode_fails_at_startup(store, monkeypatch):
    """At boot, not on the first request that needed it.

    An unknown mode used to return 500 per request. Building the interceptor
    when the application is created means the process refuses to start instead
    of serving traffic in an undefined auth state.
    """
    from phylodelta.api.app import create_app

    monkeypatch.setenv("PHYLODELTA_AUTH", "sometimes")
    with pytest.raises(RuntimeError, match="expected 'mock', 'header' or 'jwt'"):
        create_app()


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


# --- every data endpoint refuses another owner -----------------------------

@pytest.fixture(scope="module")
def owned_store(tmp_path_factory, datasets_dir):
    """A complete store — trees and isolates — all owned by `local`.

    Built separately from `real_store` because it needs isolate data too, and
    because adding that to a session-scoped fixture would change what other
    tests see.
    """
    from phylodelta.isolates.ingest import ingest_all
    from phylodelta.precompute.pipeline import ingest_trees

    store = tmp_path_factory.mktemp("owned")
    assert ingest_trees(datasets_dir=datasets_dir, store_dir=store) == 0
    assert ingest_all(datasets_dir=datasets_dir, store_dir=store) == 0
    return store


@pytest.fixture()
def two_owners(owned_store, monkeypatch):
    """That store, owned by `local`, with authentication by header."""
    from phylodelta.api.app import create_app
    from phylodelta.metrics import registry_pairs
    from phylodelta.trees import registry

    db.reset()
    for attribute, value in [
        ("STORE_DIR", owned_store), ("TREES_DIR", owned_store / "trees"),
        ("PAIRS_DIR", owned_store / "pairs"),
        ("ISOLATES_DIR", owned_store / "isolates"),
    ]:
        monkeypatch.setattr(config, attribute, value)
    monkeypatch.setenv("PHYLODELTA_AUTH", "header")
    from phylodelta.isolates import registry as isolate_registry

    for cache in (registry, registry_pairs, isolate_registry):
        cache.reset_cache()
    yield TestClient(create_app())
    for cache in (registry, registry_pairs, isolate_registry):
        cache.reset_cache()
    db.reset()


def as_owner(client: TestClient, owner: str, method: str, url: str, **kw):
    return client.request(method, url, headers={"X-PhyloDelta-Owner": owner}, **kw)


#: Every endpoint that serves owned data, with a request that works for `local`.
DATA_ENDPOINTS = [
    ("GET", "/api/v1/trees/vibrio-upgma"),
    ("GET", "/api/v1/trees/vibrio-upgma/slice?budget=10"),
    ("GET", "/api/v1/isolates/vibrio/keys"),
    ("GET", "/api/v1/isolates/vibrio/values?key=Continent"),
]


@pytest.mark.parametrize("method,url", DATA_ENDPOINTS)
def test_the_owner_can_reach_it(two_owners, method, url):
    assert as_owner(two_owners, "local", method, url).status_code == 200


@pytest.mark.parametrize("method,url", DATA_ENDPOINTS)
def test_a_stranger_cannot(two_owners, method, url):
    assert as_owner(two_owners, "stranger", method, url).status_code == 404


def test_compositions_are_owner_scoped(two_owners):
    body = {"leaves": ["1"], "segment_by": "Continent"}
    assert as_owner(
        two_owners, "local", "POST",
        "/api/v1/isolates/vibrio/compositions", json=body
    ).status_code == 200
    assert as_owner(
        two_owners, "stranger", "POST",
        "/api/v1/isolates/vibrio/compositions", json=body
    ).status_code == 404


def test_a_strangers_404_is_indistinguishable_from_a_missing_one(two_owners):
    """Otherwise ids can be probed for existence by someone who cannot read them."""
    real_but_not_yours = as_owner(two_owners, "stranger", "GET", "/api/v1/trees/vibrio-upgma")
    never_existed = as_owner(two_owners, "stranger", "GET", "/api/v1/trees/no-such-tree")

    assert real_but_not_yours.status_code == never_existed.status_code == 404
    assert real_but_not_yours.json()["code"] == never_existed.json()["code"]


def test_errors_do_not_enumerate_other_owners_data(two_owners):
    """An error naming what exists is a disclosure, however unreachable it is."""
    for method, url in [
        ("GET", "/api/v1/trees/nope"),
        ("GET", "/api/v1/isolates/nope/keys"),
        ("GET", "/api/v1/comparisons/nope__nope"),
    ]:
        body = as_owner(two_owners, "stranger", method, url).json()
        text = f"{body.get('detail', '')} {body.get('hint', '')}"
        assert "vibrio" not in text and "clostridium" not in text, url


def test_only_health_is_public(two_owners):
    """`/health` answers without credentials; everything else does not.

    `/metrics` used to be public too. It lists which metric plugins are
    registered — server capability, not anyone's data — but nothing needs it
    before signing in, and a default of "authenticated unless there is a
    reason" is the one that stays safe as endpoints are added.
    """
    assert two_owners.get("/api/v1/health").status_code == 200
    assert two_owners.get("/api/v1/metrics").status_code == 401


def test_no_route_can_be_reached_without_a_principal(two_owners):
    """The invariant the middleware exists to provide.

    This replaces an audit that read the OpenAPI document looking for an owner
    parameter on every operation. That was a *proxy* for the property — it
    checked that each route remembered to ask — and the thing it was guarding
    against had already happened once (§22.3: the comparison slice was missed).

    With authentication in front of routing, the property can be tested
    directly: call every route the application declares, with nothing, and
    require a refusal. A new endpoint is covered the moment it exists, and
    making one public means adding it to PUBLIC_PATHS, which is visible.
    """
    from phylodelta.api.app import create_app
    from phylodelta.api.auth import PUBLIC_PATHS

    document = create_app().openapi()
    checked = 0
    for path, operations in document["paths"].items():
        # A concrete value for each {placeholder}; what matters is the status,
        # and authentication is decided before the path is ever resolved.
        url = re.sub(r"\{[^}]+\}", "probe__probe", path)
        for method in operations:
            if method.upper() not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                continue
            response = two_owners.request(method.upper(), url)
            if path in PUBLIC_PATHS:
                assert response.status_code != 401, f"{method} {path} should be public"
                continue
            assert response.status_code == 401, f"{method} {path} was reachable"
            assert response.json()["code"] == "owner_required"
            checked += 1
    assert checked >= 10, "the suite should be covering every data route"


def test_a_refusal_says_how_to_authenticate(two_owners):
    """So a client library knows what to present rather than guessing."""
    response = two_owners.get("/api/v1/datasets")
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


# --- schema changes over a populated database -------------------------------

def test_a_missing_column_is_added_without_losing_rows(tmp_path):
    """The failure this prevents is not hypothetical.

    Adding `display_name` to `comparisons` broke every read against a database
    that already existed, because `create_all` skips a table that is present
    whatever shape it is in. While stores were rebuildable that was an
    inconvenience; once uploads put user data in there it is data loss.
    """
    import sqlite3

    from phylodelta import db

    with db.using_store(tmp_path):
        db.create_schema()
        db.record_upload(
            "L__R", "L", "R", "alice", "a comparison", "l.nwk", "r.nwk", "pairs/L__R"
        )

    # Simulate the older schema: drop a column the model now expects.
    database = tmp_path / "phylodelta.sqlite"
    connection = sqlite3.connect(database)
    connection.execute("ALTER TABLE comparisons DROP COLUMN display_name")
    connection.commit()
    connection.close()

    db.reset()
    with db.using_store(tmp_path):
        db.create_schema()
        recovered = db.comparison_for("alice", "L__R")
        assert recovered is not None, "the row survived the migration"
        assert recovered.left_id == "L"
        # Re-added with the model's default rather than left NULL, so the
        # migrated value matches what a fresh insert would get.
        assert recovered.display_name == ""


def test_an_unmigratable_change_is_refused_rather_than_guessed(tmp_path):
    """Additive only. Anything else fails loudly instead of losing data."""
    from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine

    from phylodelta.db.session import _add_missing_columns

    made = create_engine(f"sqlite:///{tmp_path / 'probe.sqlite'}", future=True)

    before = MetaData()
    Table("thing", before, Column("id", String(8), primary_key=True))
    before.create_all(made)

    # A new primary key cannot be added to a populated table in any engine.
    after = MetaData()
    Table(
        "thing", after,
        Column("id", String(8), primary_key=True),
        Column("second_id", String(8), primary_key=True),
    )
    with pytest.raises(RuntimeError, match="new primary key"):
        _add_missing_columns(made, after)

    # NOT NULL with nothing to give the rows already there.
    stubborn = MetaData()
    Table(
        "thing", stubborn,
        Column("id", String(8), primary_key=True),
        Column("count", Integer, nullable=False),
    )
    with pytest.raises(RuntimeError, match="no default"):
        _add_missing_columns(made, stubborn)
