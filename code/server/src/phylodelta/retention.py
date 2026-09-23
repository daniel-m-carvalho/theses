"""What it means for a comparison to go away.

Two things remove data, and this module owns both so they cannot drift:

**A successful job discards its raw upload.** Measured on the real vibrio pair,
the bundle is 9.7 MB of a 14 MB comparison — 69%, and redundant once ingested,
because the store can regenerate Newick (`newick_writer.to_newick`, which
`materialise` already uses to feed TreeDiff). Keeping it would buy byte-exact
provenance of the submission, not the ability to recompute. A **failed** job
keeps its bundle: there the original file is the evidence of what went wrong.

**A user deletes a comparison.** There is no expiry clock and no quota (user,
2026-09-23): a comparison lives until someone removes it. Deliberate — this
runs on a university VM with a container volume, where the failure mode of an
automatic sweep (a result vanishing before it was written about) is worse than
the failure mode of unbounded growth (a disk that needs attention). Quotas are
recorded as future work.

Deletion is **owner-scoped and idempotent**, and it removes the derived stores
as well as the rows. Removing the row alone would leave the expensive half on
disk — which is the whole problem this exists to solve.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from . import config, db, uploads


@dataclass(slots=True)
class Removed:
    """What a deletion actually took away. Reported so the caller can say."""

    comparison_id: str
    datasets: list[str] = field(default_factory=list)
    bytes_freed: int = 0
    paths: list[str] = field(default_factory=list)


def _size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _remove(path: Path, report: Removed) -> None:
    if not path.exists():
        return
    report.bytes_freed += _size(path)
    report.paths.append(str(path.name))
    shutil.rmtree(path, ignore_errors=True)


def discard_bundle(comparison_id: str) -> int:
    """Remove a comparison's raw upload. Returns the bytes freed.

    Called when a job succeeds. Safe to call when there is nothing there, so a
    re-run or a catalogue-built pair costs nothing.
    """
    directory = uploads.uploads_dir() / comparison_id
    freed = _size(directory)
    uploads.discard(directory)
    return freed


def remove_comparison(owner_id: str, comparison_id: str) -> Removed | None:
    """Delete a comparison and everything only it was using.

    Returns None if this owner does not have it — the same answer for "not
    yours" as for "no such id", so deletion cannot be used to probe for
    existence any more than reading can.

    Order matters. The comparison row is removed first because the dataset
    rows carry foreign keys to it; then the datasets that nothing else refers
    to; then the files. A crash between those steps leaves files without rows,
    which is inert — the opposite order would leave rows pointing at data that
    is gone, which is not.
    """
    pair = db.delete_comparison_row(owner_id, comparison_id)
    if pair is None:
        return None

    report = Removed(comparison_id=comparison_id)
    store = Path(config.STORE_DIR)

    orphaned = db.datasets_no_longer_used(pair)
    db.delete_datasets(orphaned)
    report.datasets = orphaned

    _remove(store / "pairs" / comparison_id, report)
    for dataset_id in orphaned:
        _remove(store / "trees" / dataset_id, report)
        _remove(store / "isolates" / dataset_id, report)
    # Present only if the comparison never succeeded; discarded on success.
    _remove(uploads.uploads_dir() / comparison_id, report)
    # Scratch is cleaned per-run, but a worker killed mid-metric can leave it.
    _remove(store / "scratch" / comparison_id, report)

    return report


def remove_orphaned_stores(comparison_id: str, dataset_ids: tuple[str, ...]) -> None:
    """Clean up after a job whose comparison was deleted while it ran.

    The worker computes for minutes; a user may delete the comparison in that
    window. Delete wins — the row is already gone, so what the worker wrote is
    unreachable by anyone and would otherwise sit on disk forever with nothing
    referring to it.
    """
    report = Removed(comparison_id=comparison_id)
    store = Path(config.STORE_DIR)
    _remove(store / "pairs" / comparison_id, report)
    for dataset_id in dataset_ids:
        _remove(store / "trees" / dataset_id, report)
        _remove(store / "isolates" / dataset_id, report)
    _remove(uploads.uploads_dir() / comparison_id, report)
    db.delete_datasets(list(dataset_ids))
