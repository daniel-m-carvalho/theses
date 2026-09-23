"""Running an uploaded comparison.

Uploads write a `pending` row and stop (§23). This is what picks it up: claim a
job, ingest its two trees and any typing data, compute the pair, mark it ready
or failed. It is the other half of the 202.

**It calls the same pipeline the CLI does.** `ingest_tree_file` and
`compute_pair` were extracted from the catalogue sweep for exactly this, rather
than reimplemented here. An upload and a catalogue tree are the same kind of
thing and must be canonicalised, stored and compared identically — a second
ingestion path would be the same code with its own bugs, and the places they
would hide (unary-root suppression, projection back onto stored indices) are
precisely the ones that took longest to get right.

**Failure is a recorded status, not a crash.** Everything below runs inside one
`try`, and anything raised becomes `failed` with the reason on the row. A
worker that dies instead of recording is handled a level up, by the lease in
`db.jobs`.
"""

from __future__ import annotations

import threading
import time
import traceback
from contextlib import contextmanager
from pathlib import Path

from .. import config, db, retention, uploads
from ..db import jobs as queue
from ..isolates.ingest import ingest_species
from .pipeline import NotComparable, compute_pair, ingest_tree_file, load_metrics

#: What a worker computes for an uploaded pair. RF is the headline number; the
#: correspondence gradient that drives the colouring is computed once per pair
#: regardless of which metrics run (§9).
DEFAULT_METRICS = ["rf"]


@contextmanager
def _heartbeat(comparison_id: str, worker: str):
    """Refresh the lease while the job runs.

    On a thread because the work is one long blocking call — correspondence on
    a 500k-node pair is tens of seconds with the GIL released — and a lease
    that is only refreshed between steps would expire inside the longest step,
    which is the one most likely to be running when a worker dies.
    """
    stop = threading.Event()

    def beat() -> None:
        while not stop.wait(queue.HEARTBEAT_SECONDS):
            try:
                queue.heartbeat(comparison_id, worker)
            except Exception:
                # A failed heartbeat is not a reason to abandon work that is
                # otherwise fine; the lease may expire and the job be retried,
                # which is the behaviour we already handle.
                pass

    thread = threading.Thread(target=beat, name=f"heartbeat-{comparison_id}", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)


def run_comparison(comparison_id: str, metrics: list[str] | None = None) -> tuple[str, str]:
    """Do the work for one claimed comparison. Raises on failure.

    Returns the two dataset ids it built, so the caller can clean them up if
    the comparison was deleted while this was running.
    """
    store = Path(config.STORE_DIR)
    record = db.comparison_by_id(comparison_id)
    if record is None:
        raise RuntimeError(f"comparison {comparison_id} vanished after being claimed")

    directory = uploads.uploads_dir() / comparison_id
    manifest = uploads.read_manifest(directory)
    files = manifest["files"]
    owner = record.owner_id

    # --- trees ---------------------------------------------------------
    for role, dataset_id, species in (
        ("left_tree", record.left_id, manifest.get("left_species", "")),
        ("right_tree", record.right_id, manifest.get("right_species", "")),
    ):
        db.set_dataset_status(dataset_id, db.DatasetStatus.INGESTING)
        ingest_tree_file(
            path=directory / files[role]["path"],
            trees_dir=store / "trees",
            dataset_id=dataset_id,
            owner_id=owner,
            species=species,
            method="",
            display_name=Path(files[role]["original_name"]).stem,
            source_name=files[role]["original_name"],
        )

    # --- typing data ---------------------------------------------------
    # Keyed by the tree's dataset id, not by species. A species is a global
    # name and there is only one of each; an uploaded table belongs to one
    # uploaded tree, and two users may both upload "salmonella". The id is
    # already unique and already owned.
    for role, dataset_id in (
        ("left_isolates", record.left_id),
        ("right_isolates", record.right_id),
    ):
        if role not in files:
            continue
        meta = ingest_species(
            dataset_id, directory / files[role]["path"], store / "isolates" / dataset_id
        )
        db.register_dataset(
            dataset_id=f"isolates-{dataset_id}",
            owner_id=owner,
            kind=db.DatasetKind.ISOLATES,
            display_name=f"{Path(files[role]['original_name']).stem} isolates",
            store_path=f"isolates/{dataset_id}",
            source_name=meta.source,
        )

    # --- the comparison -------------------------------------------------
    wanted = list(metrics or DEFAULT_METRICS)
    manifests, loaded = load_metrics(wanted)
    computed = compute_pair(
        store, record.left_id, record.right_id, wanted, manifests=manifests, loaded=loaded
    )
    for line in computed.report_lines:
        print(line, flush=True)
    return (record.left_id, record.right_id)


def process_next(worker: str | None = None, metrics: list[str] | None = None) -> bool:
    """Claim and run one comparison. False when the queue is empty.

    The return value is what the loop paces on: a worker that finds nothing
    sleeps, and one that finds something asks again immediately.
    """
    who = worker or queue.worker_name()
    comparison_id = queue.claim_next(who)
    if comparison_id is None:
        return False

    started = time.perf_counter()
    print(f"--- {comparison_id} claimed by {who}", flush=True)
    try:
        with _heartbeat(comparison_id, who):
            built = run_comparison(comparison_id, metrics)
    except NotComparable as exc:
        # A definite answer, not a fault: these two trees share no labels.
        # Failing with the reason beats retrying something that cannot succeed.
        queue.finish(comparison_id, error=f"Nothing to compare: {exc}")
        print(f"--- {comparison_id} failed: {exc}", flush=True)
        return True
    except Exception as exc:
        queue.finish(comparison_id, error=f"{type(exc).__name__}: {exc}")
        print(f"--- {comparison_id} failed: {exc}", flush=True)
        traceback.print_exc()
        return True

    # A comparison can be deleted while it is being computed — this takes
    # minutes on a large pair. Delete wins: the row is already gone, so
    # everything just written is unreachable and would otherwise sit on disk
    # with nothing referring to it.
    if db.comparison_by_id(comparison_id) is None:
        retention.remove_orphaned_stores(comparison_id, built)
        print(f"--- {comparison_id} was deleted while running; discarded", flush=True)
        return True

    queue.finish(comparison_id)
    # The raw bundle is ~69% of a stored comparison and redundant once
    # ingested. Kept only when the job failed, where it is the evidence.
    freed = retention.discard_bundle(comparison_id)
    print(
        f"--- {comparison_id} ready in {time.perf_counter() - started:,.1f} s"
        + (f", {freed / 1024 / 1024:,.1f} MB of upload discarded" if freed else ""),
        flush=True,
    )
    return True


def work(
    once: bool = False,
    poll_seconds: float = 2.0,
    metrics: list[str] | None = None,
    lease_seconds: int = queue.DEFAULT_LEASE_SECONDS,
) -> int:
    """The worker loop.

    Polls rather than listens. At a handful of uploads a minute the latency
    that costs is bounded by `poll_seconds` and the query is an indexed lookup
    on a status column; LISTEN/NOTIFY would be faster and would only work on
    PostgreSQL, which would give up the property §18 was careful to keep.
    """
    who = queue.worker_name()
    print(f"worker {who} started; polling every {poll_seconds:g}s", flush=True)
    db.create_schema()

    while True:
        # Before claiming: a job whose worker died is unreachable until
        # someone returns it, and the worker that notices is whichever one is
        # next idle.
        requeued, failed = queue.reclaim_stale(lease_seconds)
        if requeued or failed:
            print(
                f"reclaimed {requeued} abandoned job(s), failed {failed} past retry",
                flush=True,
            )

        worked = process_next(who, metrics)
        if once and not worked:
            return 0
        if not worked:
            time.sleep(poll_seconds)
