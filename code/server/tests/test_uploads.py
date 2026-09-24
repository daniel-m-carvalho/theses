"""Uploading a comparison bundle.

What these assert, beyond "it returns 202": that a refused upload leaves
nothing behind, that an accepted one is not servable before a job has run, and
that a bundle belongs to whoever sent it.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from phylodelta import config, db, uploads
from phylodelta.api.app import create_app
from phylodelta.api.identity import AUTH_HEADER

LEFT = b"((A:0.1,B:0.2):0.3,C:0.4);"
RIGHT = b"(A:0.1,(B:0.2,C:0.3):0.4);"
TABLE = b"ST\tcountry\tyear\nA\tPT\t2020\nB\tES\t2021\nC\tPT\t2019\n"


@pytest.fixture
def client(tmp_path, monkeypatch):
    """An app whose store, and therefore database, is a fresh directory."""
    monkeypatch.setenv("PHYLODELTA_STORE", str(tmp_path))
    monkeypatch.setattr(config, "STORE_DIR", tmp_path)
    monkeypatch.setenv("PHYLODELTA_AUTH", "header")
    with db.using_store(tmp_path):
        db.create_schema()
        yield TestClient(create_app(), raise_server_exceptions=False)


def as_owner(who: str) -> dict[str, str]:
    return {AUTH_HEADER: who}


def bundle(**overrides):
    files = {
        "left_tree": ("nj.nwk", io.BytesIO(LEFT)),
        "right_tree": ("upgma.nwk", io.BytesIO(RIGHT)),
    }
    files.update(overrides)
    return {k: v for k, v in files.items() if v is not None}


def test_a_bundle_is_accepted_and_reported_pending(client, tmp_path):
    response = client.post(
        "/api/v1/comparisons", files=bundle(), headers=as_owner("alice")
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "pending"
    # The id is the pair id: one identifier addresses it everywhere.
    assert body["id"] == f"{body['left_id']}__{body['right_id']}"
    assert body["poll"].endswith("/status")

    status = client.get(body["poll"], headers=as_owner("alice"))
    assert status.status_code == 200
    assert status.json()["status"] == "pending"
    assert status.json()["ready"] is False


def test_isolate_tables_are_optional(client):
    """A pair of one species needs no second table, and may need none at all."""
    for extra in (
        {},
        {"left_isolates": ("meta.tsv", io.BytesIO(TABLE))},
        {
            "left_isolates": ("l.tsv", io.BytesIO(TABLE)),
            "right_isolates": ("r.tsv", io.BytesIO(TABLE)),
        },
    ):
        response = client.post(
            "/api/v1/comparisons", files=bundle(**extra), headers=as_owner("alice")
        )
        assert response.status_code == 202, response.text


def test_both_trees_are_required(client):
    response = client.post(
        "/api/v1/comparisons",
        files={"left_tree": ("nj.nwk", io.BytesIO(LEFT))},
        headers=as_owner("alice"),
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "role,payload",
    [
        ("left_tree", b"%PDF-1.4 not a tree"),
        ("right_tree", b""),
        ("left_isolates", b"one-column-no-tabs"),
    ],
)
def test_implausible_files_are_refused_with_the_field_named(client, role, payload):
    files = bundle(**{role: (f"bad{Path(role).suffix}", io.BytesIO(payload))})
    response = client.post("/api/v1/comparisons", files=files, headers=as_owner("alice"))
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "upload_rejected"
    assert role in body["hint"]


def test_a_refused_upload_leaves_nothing_behind(client, tmp_path):
    """Whole or not at all: no fragments for a later job to find."""
    client.post(
        "/api/v1/comparisons",
        files=bundle(right_tree=("bad.nwk", io.BytesIO(b"%PDF"))),
        headers=as_owner("alice"),
    )
    assert list((tmp_path / "uploads").glob("*")) == []
    assert db.comparisons_for("alice") == []


def test_an_oversized_file_is_refused_before_it_is_fully_written(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYLODELTA_MAX_UPLOAD_BYTES", "1024")
    big = b"(" + b"A," * 4000 + b"B);"
    response = client.post(
        "/api/v1/comparisons",
        files=bundle(left_tree=("big.nwk", io.BytesIO(big))),
        headers=as_owner("alice"),
    )
    assert response.status_code == 400
    assert "limit" in response.json()["detail"]
    assert list((tmp_path / "uploads").glob("*")) == []


def test_an_uploaded_tree_is_not_servable_until_a_job_has_run(client):
    """The property that makes 202 safe.

    Between upload and ingestion the row exists but there is no store. If a
    pending dataset were servable, a client could ask for a tree whose data has
    not been written and get an error from deep inside a reader instead of an
    honest 404.
    """
    body = client.post(
        "/api/v1/comparisons", files=bundle(), headers=as_owner("alice")
    ).json()
    for path in (
        f"/api/v1/trees/{body['left_id']}",
        f"/api/v1/trees/{body['left_id']}/slice?budget=10",
        f"/api/v1/comparisons/{body['id']}",
    ):
        assert client.get(path, headers=as_owner("alice")).status_code == 404, path


def test_a_bundle_belongs_to_whoever_sent_it(client):
    body = client.post(
        "/api/v1/comparisons", files=bundle(), headers=as_owner("alice")
    ).json()
    mine = client.get(body["poll"], headers=as_owner("alice"))
    theirs = client.get(body["poll"], headers=as_owner("bob"))
    assert mine.status_code == 200
    assert theirs.status_code == 404
    # The same 404 a nonexistent id gets: bob cannot tell the two apart.
    absent = client.get(
        "/api/v1/comparisons/nope__nope/status", headers=as_owner("bob")
    )
    assert theirs.json()["code"] == absent.json()["code"] == "comparison_not_found"


def test_upload_requires_an_owner(client):
    assert client.post("/api/v1/comparisons", files=bundle()).status_code == 401


def test_the_manifest_describes_the_bundle(client, tmp_path):
    body = client.post(
        "/api/v1/comparisons",
        files=bundle(left_isolates=("meta.tsv", io.BytesIO(TABLE))),
        headers=as_owner("alice"),
    )
    directory = tmp_path / "uploads" / body.json()["id"]
    manifest = json.loads((directory / "bundle.json").read_text())
    assert manifest["comparison_id"] == body.json()["id"]
    assert set(manifest["files"]) == {"left_tree", "right_tree", "left_isolates"}
    assert manifest["files"]["left_tree"]["original_name"] == "nj.nwk"
    # Bytes arrived intact, not merely counted.
    assert (directory / "left_tree.nwk").read_bytes() == LEFT
    assert manifest["files"]["left_tree"]["size_bytes"] == len(LEFT)


def test_the_name_defaults_to_the_filenames(client):
    body = client.post(
        "/api/v1/comparisons", files=bundle(), headers=as_owner("alice")
    ).json()
    assert client.get(body["poll"], headers=as_owner("alice")).json()[
        "display_name"
    ] == "nj vs upgma"


def test_a_given_name_is_kept(client):
    body = client.post(
        "/api/v1/comparisons",
        files=bundle(),
        data={"name": "Vibrio NJ against UPGMA"},
        headers=as_owner("alice"),
    ).json()
    assert client.get(body["poll"], headers=as_owner("alice")).json()[
        "display_name"
    ] == "Vibrio NJ against UPGMA"


def test_two_uploads_of_the_same_files_are_separate_comparisons(client):
    """Identity comes from the upload, not from the bytes or the filename."""
    first = client.post("/api/v1/comparisons", files=bundle(), headers=as_owner("alice"))
    second = client.post("/api/v1/comparisons", files=bundle(), headers=as_owner("alice"))
    assert first.json()["id"] != second.json()["id"]
    assert len(db.comparisons_for("alice")) == 2


def test_two_owners_uploading_the_same_filename_do_not_collide(client):
    alice = client.post("/api/v1/comparisons", files=bundle(), headers=as_owner("alice"))
    bob = client.post("/api/v1/comparisons", files=bundle(), headers=as_owner("bob"))
    assert alice.json()["id"] != bob.json()["id"]
    assert [c.id for c in db.comparisons_for("alice")] == [alice.json()["id"]]
    assert [c.id for c in db.comparisons_for("bob")] == [bob.json()["id"]]


def _bundle(client, **form):
    return client.post(
        "/api/v1/comparisons",
        files=bundle(),
        data={"name": "metric-choice", **form},
        headers=as_owner("alice"),
    )


def test_upload_records_the_metrics_it_was_asked_for(client):
    # On the row, not on the worker: a worker flag applies to whatever job it
    # picks up, so two uploads made with different choices would both get
    # whichever the running worker happened to be started with.
    got = _bundle(client, metrics="rf")
    assert got.status_code == 202, got.text
    status = client.get(
        f"/api/v1/comparisons/{got.json()['id']}/status", headers=as_owner("alice")
    ).json()
    assert status["metrics"] == ["rf"]


def test_upload_defaults_to_rf_when_no_metric_is_named(client):
    got = _bundle(client)
    assert got.status_code == 202, got.text
    status = client.get(
        f"/api/v1/comparisons/{got.json()['id']}/status", headers=as_owner("alice")
    ).json()
    assert status["metrics"] == ["rf"]


def test_upload_refuses_an_unknown_metric_and_says_what_exists(client):
    # A typo that fell back to the default would produce a comparison the user
    # did not ask for and cannot tell apart from one they did, minutes later
    # and in another process.
    got = _bundle(client, metrics="rf,not-a-metric")
    assert got.status_code == 422, got.text
    body = got.json()
    assert "not-a-metric" in body["detail"]
    assert "rf" in body["hint"]


def test_upload_refuses_before_storing_anything(client, tmp_path):
    # The names are in the request, so refusing after streaming the bundle to
    # disk would be work spent to reach an answer that was available at once.
    from phylodelta import uploads

    def stored() -> list[str]:
        # Not created until something is actually stored, which is the state
        # this test wants to still be in afterwards.
        directory = uploads.uploads_dir()
        return sorted(p.name for p in directory.iterdir()) if directory.exists() else []

    before = stored()
    assert _bundle(client, metrics="nope").status_code == 422
    assert stored() == before


def test_upload_drops_a_repeated_metric_rather_than_computing_it_twice(client):
    got = _bundle(client, metrics="rf,rf")
    assert got.status_code == 202, got.text
    status = client.get(
        f"/api/v1/comparisons/{got.json()['id']}/status", headers=as_owner("alice")
    ).json()
    assert status["metrics"] == ["rf"]
