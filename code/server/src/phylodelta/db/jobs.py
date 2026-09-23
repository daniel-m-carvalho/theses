"""The queue.

A comparison row *is* its own queue entry (see `models.Comparison`). What this
module adds is the four operations a worker needs, shaped so that running more
than one worker is safe.

**Why a database queue and not Redis, Celery or RQ.** §18 settled that a module
owns its storage and that the whole backend still runs from `uv sync` and a
directory. A broker would be a second service to install, configure and keep
alive, bought for a workload of at most a few jobs per minute. The database is
already there, already has the row, and already has the transaction — and the
same code runs unchanged on SQLite and PostgreSQL, which is the substitution
§18 promised.

**Why claiming is an UPDATE and not a SELECT.** The tempting version reads the
oldest pending row and then marks it running. Between those two statements
another worker can read the same row, and both then compute the same
comparison — writing to the same store directory at the same time. Instead the
claim is a single conditional UPDATE:

    UPDATE comparisons SET status='running', ... WHERE id=? AND status='pending'

The database decides. Exactly one worker sees `rowcount == 1`; everyone else
sees 0 and moves to the next candidate. This needs no `SELECT FOR UPDATE`,
which SQLite does not have, so the one implementation is correct on both
engines rather than correct on one and approximated on the other.
"""

from __future__ import annotations

import os
import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from .models import Comparison, ComparisonStatus
from .session import session

#: A job claimed but not heartbeated within this is treated as abandoned. Must
#: be comfortably longer than the heartbeat interval: too short and a slow but
#: healthy job is stolen and run twice; too long and a crashed worker's job
#: sits unavailable. The margin is deliberately wide because the cost of
#: waiting is a delay and the cost of stealing is duplicated work.
DEFAULT_LEASE_SECONDS = 300

#: How often a running job refreshes its lease.
HEARTBEAT_SECONDS = 30

#: A job reclaimed this many times has failed this many times. Bounded so that
#: a comparison which reliably kills its worker — a pathological tree, an
#: out-of-memory parse — ends as `failed` with a reason instead of cycling
#: forever and blocking the queue behind it.
MAX_ATTEMPTS = 3


def _now() -> datetime:
    return datetime.now(UTC)


def worker_name() -> str:
    """Identifies a worker in the rows it claims. Diagnostic, not a lock."""
    return f"{socket.gethostname()}:{os.getpid()}"


def claim_next(worker: str | None = None) -> str | None:
    """Take the oldest pending comparison, or return None.

    Returns only the id. The row is deliberately not returned: it would be
    detached from its session, and every caller wants the ids rather than a
    live object.
    """
    who = worker or worker_name()
    with session() as active:
        candidates = list(
            active.scalars(
                select(Comparison.id)
                .where(Comparison.status == ComparisonStatus.PENDING)
                .order_by(Comparison.created_at, Comparison.id)
                .limit(16)
            )
        )

    for candidate in candidates:
        with session() as active:
            now = _now()
            claimed = active.execute(
                update(Comparison)
                .where(
                    Comparison.id == candidate,
                    # The whole of the mutual exclusion. If another worker got
                    # here first the status is no longer pending and this
                    # matches nothing.
                    Comparison.status == ComparisonStatus.PENDING,
                )
                .values(
                    status=ComparisonStatus.RUNNING,
                    worker=who,
                    started_at=now,
                    heartbeat_at=now,
                    attempts=Comparison.attempts + 1,
                )
            )
            if claimed.rowcount == 1:
                return candidate
    return None


def heartbeat(comparison_id: str, worker: str | None = None) -> None:
    """Refresh the lease on a job this worker holds.

    Scoped to the holder: if the job was reclaimed while this worker was busy,
    the UPDATE matches nothing rather than silently taking it back from
    whoever owns it now.
    """
    who = worker or worker_name()
    with session() as active:
        active.execute(
            update(Comparison)
            .where(
                Comparison.id == comparison_id,
                Comparison.worker == who,
                Comparison.status == ComparisonStatus.RUNNING,
            )
            .values(heartbeat_at=_now())
        )


def finish(comparison_id: str, error: str | None = None) -> None:
    """Record a job as ready, or as failed with a reason."""
    with session() as active:
        active.execute(
            update(Comparison)
            .where(Comparison.id == comparison_id)
            .values(
                status=ComparisonStatus.FAILED if error else ComparisonStatus.READY,
                error=error,
                finished_at=_now(),
            )
        )


def reclaim_stale(lease_seconds: int = DEFAULT_LEASE_SECONDS) -> tuple[int, int]:
    """Return abandoned jobs to the queue. ``(requeued, failed)``.

    A worker that is killed — OOM, a container restart, a lost machine —
    leaves its job `running` with a heartbeat that stops advancing. Without
    this the comparison is stuck in a state no worker will ever claim, and the
    user polls `running` forever.

    A job that has exhausted its attempts is failed rather than requeued,
    because repeatedly killing a worker is a property of the job.
    """
    cutoff = _now() - timedelta(seconds=lease_seconds)
    with session() as active:
        stale = list(
            active.scalars(
                select(Comparison.id).where(
                    Comparison.status == ComparisonStatus.RUNNING,
                    Comparison.heartbeat_at < cutoff,
                )
            )
        )
        if not stale:
            return (0, 0)
        requeued = active.execute(
            update(Comparison)
            .where(
                Comparison.id.in_(stale),
                Comparison.attempts < MAX_ATTEMPTS,
            )
            .values(status=ComparisonStatus.PENDING, worker=None, heartbeat_at=None)
        ).rowcount
        failed = active.execute(
            update(Comparison)
            .where(
                Comparison.id.in_(stale),
                Comparison.attempts >= MAX_ATTEMPTS,
            )
            .values(
                status=ComparisonStatus.FAILED,
                finished_at=_now(),
                error=(
                    f"Abandoned by its worker {MAX_ATTEMPTS} times without "
                    "completing. The worker is being killed rather than "
                    "failing — most likely the trees are too large for the "
                    "memory available."
                ),
            )
        ).rowcount
        return (requeued, failed)


def queue_depth() -> dict[str, int]:
    """How many comparisons sit in each status. For /health and for operators."""
    with session() as active:
        return {
            status.value: len(
                list(
                    active.scalars(
                        select(Comparison.id).where(Comparison.status == status)
                    )
                )
            )
            for status in ComparisonStatus
        }
