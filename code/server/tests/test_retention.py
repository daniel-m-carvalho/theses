"""What removes data, and what it is careful about.

There is no expiry clock and no quota (user, 2026-09-23): a comparison lives
until someone deletes it. So the two things that remove data are a successful
job discarding its raw upload, and a user asking.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from phylodelta import config, db, retention
from phylodelta.api.app import create_app
from phylodelta.api.identity import AUTH_HEADER
from phylodelta.db import jobs as queue
from phylodelta.precompute.jobs import process_next

LEFT = b"(((A:0.1,B:0.1):0.1,C:0.2):0.1,D:0.3);"
RIGHT = b"(((A:0.1,C:0.1):0.1,B:0.2):0.1,D:0.3);"
TABLE = b"ST\tcountry\nA\tPT\nB\tES\nC\tPT\nD\tFR\n"


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PHYLODELTA_STORE", str(tmp_path))
    for name, sub in (
        ("STORE_DIR", ""), ("TREES_DIR", "trees"), ("PAIRS_DIR", "pairs"),
        ("ISOLATES_DIR", "isolates"), ("SCRATCH_DIR", "scratch"),
    ):
        monkeypatch.setattr(config, name, tmp_path / sub if sub else tmp_path)
    monkeypatch.setenv("PHYLODELTA_AUTH", "header")
    db.reset()
    with db.using_store(tmp_path):
        db.create_schema()
        yield tmp_path


@pytest.fixture
def client(store):
    from phylodelta.metrics import registry_pairs
    from phylodelta.trees import registry

    registry.reset_cache()
    registry_pairs.reset_cache()
    return TestClient(create_app(), raise_server_exceptions=False)


def upload(client, left=LEFT, right=RIGHT, owner="alice", **extra) -> str:
    files = {
        "left_tree": ("nj.nwk", io.BytesIO(left)),
        "right_tree": ("upgma.nwk", io.BytesIO(right)),
    }
    files.update(extra)
    response = client.post(
        "/api/v1/comparisons", files=files, headers={AUTH_HEADER: owner}
    )
    assert response.status_code == 202, response.text
    return response.json()["id"]


# --- a successful job discards its bundle -----------------------------------

def test_a_successful_job_discards_the_raw_upload(client, store):
    """~69% of a stored comparison, and redundant once ingested: the store can
    regenerate Newick, so keeping it buys provenance, not recomputability."""
    comparison_id = upload(client, left_isolates=("meta.tsv", io.BytesIO(TABLE)))
    bundle = store / "uploads" / comparison_id
    assert bundle.exists()

    process_next("w1")

    assert not bundle.exists()
    # And the derived data it was ingested into is still there.
    assert (store / "pairs" / comparison_id).exists()
    left_id = comparison_id.split("__")[0]
    assert (store / "trees" / left_id).exists()
    assert (store / "isolates" / left_id).exists()


def test_a_failed_job_keeps_its_bundle(client, store):
    """There the original file is the evidence of what went wrong."""
    comparison_id = upload(client, left=b"(A,B,C,D);")
    process_next("w1")

    assert db.comparison_for("alice", comparison_id).status.value == "failed"
    assert (store / "uploads" / comparison_id).exists()


# --- deleting -----------------------------------------------------------

def test_deleting_removes_the_rows_and_the_stores(client, store):
    """Removing the row alone would leave the expensive half on disk."""
    comparison_id = upload(client, left_isolates=("meta.tsv", io.BytesIO(TABLE)))
    process_next("w1")
    left_id, right_id = comparison_id.split("__")

    response = client.delete(
        f"/api/v1/comparisons/{comparison_id}", headers={AUTH_HEADER: "alice"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body["datasets_removed"]) == {left_id, right_id}
    assert body["bytes_freed"] > 0

    assert db.comparison_for("alice", comparison_id) is None
    assert db.dataset_for("alice", left_id) is None
    for path in (
        store / "pairs" / comparison_id,
        store / "trees" / left_id,
        store / "trees" / right_id,
        store / "isolates" / left_id,
    ):
        assert not path.exists(), path

    # And it is gone from the listing.
    listed = client.get("/api/v1/datasets", headers={AUTH_HEADER: "alice"}).json()
    assert listed["pairs"] == [] and listed["trees"] == []


def test_deleting_a_pending_comparison_takes_it_out_of_the_queue(client, store):
    comparison_id = upload(client)
    assert queue.queue_depth()["pending"] == 1

    assert client.delete(
        f"/api/v1/comparisons/{comparison_id}", headers={AUTH_HEADER: "alice"}
    ).status_code == 200

    assert queue.queue_depth()["pending"] == 0
    assert queue.claim_next("w1") is None
    assert not (store / "uploads" / comparison_id).exists()


def test_only_the_owner_can_delete(client, store):
    comparison_id = upload(client, owner="alice")
    process_next("w1")

    refused = client.delete(
        f"/api/v1/comparisons/{comparison_id}", headers={AUTH_HEADER: "bob"}
    )
    assert refused.status_code == 404
    # The same answer a nonexistent id gets, so deleting cannot probe either.
    absent = client.delete(
        "/api/v1/comparisons/nope__nope", headers={AUTH_HEADER: "bob"}
    )
    assert refused.json()["code"] == absent.json()["code"] == "comparison_not_found"
    # And nothing was removed.
    assert db.comparison_for("alice", comparison_id) is not None


def test_deleting_twice_is_a_404_not_an_error(client, store):
    comparison_id = upload(client)
    process_next("w1")
    headers = {AUTH_HEADER: "alice"}
    assert client.delete(f"/api/v1/comparisons/{comparison_id}", headers=headers).status_code == 200
    assert client.delete(f"/api/v1/comparisons/{comparison_id}", headers=headers).status_code == 404


def test_a_tree_another_comparison_still_uses_is_kept(client, store):
    """Today nothing shares a tree; the check exists because comparing two
    datasets you already own is recorded as future work, and without it that
    change would make deletion destroy the other comparison's data."""
    comparison_id = upload(client)
    process_next("w1")
    left_id, right_id = comparison_id.split("__")

    # A second comparison over the same two trees.
    db.record_computed_pair(
        pair_id="second__pair", left_id=left_id, right_id=right_id,
        owner_id="alice", display_name="another",
    )

    removed = retention.remove_comparison("alice", comparison_id)
    assert removed.datasets == [], "neither tree is free"
    assert (store / "trees" / left_id).exists()
    assert db.dataset_for("alice", left_id) is not None

    # Removing the last one frees them.
    freed = retention.remove_comparison("alice", "second__pair")
    assert set(freed.datasets) == {left_id, right_id}
    assert not (store / "trees" / left_id).exists()


def test_deleting_while_it_computes_discards_what_the_worker_built(client, store, monkeypatch):
    """Delete wins.

    A large pair takes minutes; a user may delete it in that window. The worker
    must not finish into a comparison nobody can reach, leaving its stores on
    disk with no row referring to them.
    """
    comparison_id = upload(client)
    left_id, right_id = comparison_id.split("__")

    from phylodelta.precompute import jobs as runner

    real = runner.run_comparison

    def delete_midway(cid, metrics=None):
        built = real(cid, metrics)
        # The user deletes it while the worker is still holding the job.
        assert retention.remove_comparison("alice", cid) is not None
        return built

    monkeypatch.setattr(runner, "run_comparison", delete_midway)
    assert runner.process_next("w1") is True

    assert db.comparison_by_id(comparison_id) is None
    assert db.dataset_for("alice", left_id) is None
    for path in (
        store / "pairs" / comparison_id,
        store / "trees" / left_id,
        store / "trees" / right_id,
        store / "uploads" / comparison_id,
    ):
        assert not path.exists(), path


def test_deleting_needs_authentication(client, store):
    comparison_id = upload(client)
    assert client.delete(f"/api/v1/comparisons/{comparison_id}").status_code == 401
    assert db.comparison_by_id(comparison_id) is not None
