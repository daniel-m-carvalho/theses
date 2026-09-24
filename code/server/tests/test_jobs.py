"""The queue, and the worker that drains it.

Uploads write a `pending` row (§23); these cover the other half. The parts
worth testing are not "does it compute" — the pipeline is covered elsewhere and
the worker calls exactly that code — but the states around it: two workers must
not take the same job, a dead worker's job must come back, and a job that
cannot succeed must fail with a reason rather than cycle.
"""

from __future__ import annotations

import io
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from phylodelta import config, db
from phylodelta.api.app import create_app
from phylodelta.api.identity import AUTH_HEADER
from phylodelta.db import jobs as queue
from phylodelta.db.models import Comparison, ComparisonStatus

# Two small trees that disagree, over the same four leaves.
LEFT = b"(((A:0.1,B:0.1):0.1,C:0.2):0.1,D:0.3);"
RIGHT = b"(((A:0.1,C:0.1):0.1,B:0.2):0.1,D:0.3);"
TABLE = b"ST\tcountry\nA\tPT\nB\tES\nC\tPT\nD\tFR\n"


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PHYLODELTA_STORE", str(tmp_path))
    # All four, not just STORE_DIR: the other three are derived from it at
    # import time, so patching only STORE_DIR leaves the API reading the real
    # store while the worker writes to the temporary one.
    monkeypatch.setattr(config, "STORE_DIR", tmp_path)
    monkeypatch.setattr(config, "TREES_DIR", tmp_path / "trees")
    monkeypatch.setattr(config, "PAIRS_DIR", tmp_path / "pairs")
    monkeypatch.setattr(config, "ISOLATES_DIR", tmp_path / "isolates")
    monkeypatch.setattr(config, "SCRATCH_DIR", tmp_path / "scratch")
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


def enqueue(n: int = 1, owner: str = "alice") -> list[str]:
    ids = []
    for i in range(n):
        pair = f"L{i}__R{i}"
        db.record_upload(pair, f"L{i}", f"R{i}", owner, f"job {i}", "l", "r", "p")
        ids.append(pair)
    return ids


# --- claiming ---------------------------------------------------------------

def test_an_empty_queue_yields_nothing(store):
    assert queue.claim_next("w1") is None


def test_a_claimed_job_cannot_be_claimed_again(store):
    """The whole of the mutual exclusion, in one assertion.

    Claiming is a conditional UPDATE rather than a read followed by a write:
    between those two statements a second worker could read the same row, and
    both would then compute the same comparison into the same directory.
    """
    enqueue(1)
    assert queue.claim_next("w1") == "L0__R0"
    assert queue.claim_next("w2") is None


def test_every_job_goes_to_exactly_one_worker(store):
    enqueue(25)
    taken: list[str] = []
    for _ in range(25):
        for worker in ("w1", "w2", "w3"):
            got = queue.claim_next(worker)
            if got:
                taken.append(got)
    assert len(taken) == 25
    assert len(set(taken)) == 25


def test_claiming_counts_an_attempt(store):
    enqueue(1)
    queue.claim_next("w1")
    with db.session() as active:
        assert active.get(Comparison, "L0__R0").attempts == 1


def test_the_oldest_job_goes_first(store):
    enqueue(3)
    assert queue.claim_next("w1") == "L0__R0"


# --- leases and recovery ----------------------------------------------------

def _age(comparison_id: str, seconds: int) -> None:
    """Backdate a heartbeat, as a dead worker would leave it."""
    with db.session() as active:
        active.get(Comparison, comparison_id).heartbeat_at = datetime.now(UTC) - timedelta(
            seconds=seconds
        )


def test_a_fresh_job_is_not_reclaimed(store):
    enqueue(1)
    queue.claim_next("w1")
    assert queue.reclaim_stale(lease_seconds=300) == (0, 0)


def test_an_abandoned_job_returns_to_the_queue(store):
    """Without this, a worker killed mid-job leaves the comparison `running`
    forever: no worker will claim it and the user polls a status that never
    moves."""
    enqueue(1)
    queue.claim_next("w1")
    _age("L0__R0", 600)

    assert queue.reclaim_stale(lease_seconds=300) == (1, 0)
    assert queue.claim_next("w2") == "L0__R0"


def test_a_job_that_keeps_killing_its_worker_eventually_fails(store):
    """Bounded retries, so one poison job cannot occupy the queue forever."""
    enqueue(1)
    for _ in range(queue.MAX_ATTEMPTS):
        assert queue.claim_next("w1") == "L0__R0"
        _age("L0__R0", 600)
        queue.reclaim_stale(lease_seconds=300)

    # The attempt that exhausts the budget fails it instead of requeuing.
    assert queue.reclaim_stale(lease_seconds=300) == (0, 0)
    record = db.comparison_for("alice", "L0__R0")
    assert record.status is ComparisonStatus.FAILED
    assert "Abandoned" in record.error
    assert queue.claim_next("w2") is None


def test_a_heartbeat_keeps_a_job_from_being_reclaimed(store):
    enqueue(1)
    queue.claim_next("w1")
    _age("L0__R0", 600)
    queue.heartbeat("L0__R0", "w1")
    assert queue.reclaim_stale(lease_seconds=300) == (0, 0)


def test_only_the_holder_can_heartbeat(store):
    """A worker whose job was reclaimed must not be able to take it back from
    whoever holds it now."""
    enqueue(1)
    queue.claim_next("w1")
    _age("L0__R0", 600)
    queue.reclaim_stale(lease_seconds=300)
    queue.claim_next("w2")
    before = db.comparison_for("alice", "L0__R0").heartbeat_at

    queue.heartbeat("L0__R0", "w1")
    assert db.comparison_for("alice", "L0__R0").heartbeat_at == before


# --- finishing --------------------------------------------------------------

def test_finishing_records_ready_or_the_reason(store):
    enqueue(2)
    queue.claim_next("w1")
    queue.finish("L0__R0")
    done = db.comparison_for("alice", "L0__R0")
    assert done.status is ComparisonStatus.READY
    assert done.error is None and done.finished_at is not None

    queue.claim_next("w1")
    queue.finish("L1__R1", error="trees share no labels")
    failed = db.comparison_for("alice", "L1__R1")
    assert failed.status is ComparisonStatus.FAILED
    assert failed.error == "trees share no labels"


def test_queue_depth_counts_each_status(store):
    enqueue(3)
    queue.claim_next("w1")
    depth = queue.queue_depth()
    assert depth["pending"] == 2 and depth["running"] == 1


# --- the worker end to end --------------------------------------------------

def test_an_upload_becomes_a_computed_comparison(client, store):
    """The other half of the 202: upload, worker, readable result."""
    from phylodelta.precompute.jobs import process_next

    comparison_id = upload(client, left_isolates=("meta.tsv", io.BytesIO(TABLE)))
    headers = {AUTH_HEADER: "alice"}

    assert process_next("w1") is True
    assert process_next("w1") is False, "the queue is empty afterwards"

    status = client.get(
        f"/api/v1/comparisons/{comparison_id}/status", headers=headers
    ).json()
    assert status["status"] == "ready" and status["ready"] is True
    assert status["error"] is None

    # And it is now actually servable, which is the point.
    body = client.get(f"/api/v1/comparisons/{comparison_id}", headers=headers).json()
    assert body["summary"]["rf"] == 1
    left_id = comparison_id.split("__")[0]
    assert client.get(f"/api/v1/trees/{left_id}", headers=headers).status_code == 200
    assert (
        client.get(f"/api/v1/isolates/{left_id}/keys", headers=headers).status_code
        == 200
    )


def test_the_trees_are_only_servable_once_the_job_has_run(client, store):
    from phylodelta.precompute.jobs import process_next

    comparison_id = upload(client)
    left_id = comparison_id.split("__")[0]
    headers = {AUTH_HEADER: "alice"}
    assert client.get(f"/api/v1/trees/{left_id}", headers=headers).status_code == 404
    process_next("w1")
    assert client.get(f"/api/v1/trees/{left_id}", headers=headers).status_code == 200


def test_trees_with_no_shared_labels_fail_with_the_reason(client, store):
    """A definite answer, not a fault: retrying cannot help, so it fails."""
    from phylodelta.precompute.jobs import process_next

    comparison_id = upload(client, left=b"((A,B),C);", right=b"((X,Y),Z);")
    assert process_next("w1") is True

    record = db.comparison_for("alice", comparison_id)
    assert record.status is ComparisonStatus.FAILED
    assert "Nothing to compare" in record.error


def test_an_unparseable_tree_fails_the_job_rather_than_the_worker(client, store):
    """The door check is deliberately cheap (§23.3), so a file that looks like
    Newick and is not gets here. It must become a recorded status."""
    from phylodelta.precompute.jobs import process_next

    # Passes the structural check -- starts '(', ends ';' -- but is not a
    # rooted binary tree.
    comparison_id = upload(client, left=b"(A,B,C);")
    assert process_next("w1") is True

    record = db.comparison_for("alice", comparison_id)
    assert record.status is ComparisonStatus.FAILED
    assert record.error
    # The worker is still alive and still working.
    assert process_next("w1") is False


def test_a_failed_job_does_not_leave_a_readable_comparison(client, store):
    from phylodelta.precompute.jobs import process_next

    comparison_id = upload(client, left=b"((A,B),C);", right=b"((X,Y),Z);")
    process_next("w1")
    assert (
        client.get(
            f"/api/v1/comparisons/{comparison_id}", headers={AUTH_HEADER: "alice"}
        ).status_code
        == 404
    )


def test_the_worker_computes_for_the_uploader_not_itself(client, store):
    """The worker is not a requester: what it builds belongs to whoever
    uploaded it, and must not become visible to anyone else."""
    from phylodelta.precompute.jobs import process_next

    comparison_id = upload(client, owner="alice")
    process_next("w1")

    assert db.comparison_for("alice", comparison_id).owner_id == "alice"
    left_id = comparison_id.split("__")[0]
    assert db.dataset_for("alice", left_id) is not None
    assert db.dataset_for("bob", left_id) is None
    assert (
        client.get(
            f"/api/v1/comparisons/{comparison_id}", headers={AUTH_HEADER: "bob"}
        ).status_code
        == 404
    )


def test_declared_species_reaches_the_result(client, store):
    from phylodelta.precompute.jobs import process_next

    comparison_id = upload(
        client,
        left_species=(None, "vibrio"),
        right_species=(None, "clostridium"),
    )
    process_next("w1")
    body = client.get(
        f"/api/v1/comparisons/{comparison_id}", headers={AUTH_HEADER: "alice"}
    ).json()
    assert body["same_species"] is False
    assert body["caution"] is None


def test_undeclared_species_is_reported_as_unknown_not_as_matching(client, store):
    """`None`, never `True`. "We did not check" must not read as "we checked"."""
    from phylodelta.precompute.jobs import process_next

    comparison_id = upload(client)
    process_next("w1")
    body = client.get(
        f"/api/v1/comparisons/{comparison_id}", headers={AUTH_HEADER: "alice"}
    ).json()
    assert body["same_species"] is None
    assert "not declared" in body["caution"]
