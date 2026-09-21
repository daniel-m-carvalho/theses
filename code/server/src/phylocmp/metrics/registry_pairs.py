"""Find and open computed comparisons.

Mirrors ``trees.registry``: one memory-mapped reader per directory, opened once
and shared. A reader holds maps, not data.

Two things live under a pair: its **correspondence**, which is shared and keyed
by pair alone, and each **metric's** own columns. Correspondence is what
``order=difference`` ranks by, which is why that navigation mode works for any
metric — including one that contributes no per-node columns at all.
"""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

from .. import config
from .store import CORRESPONDENCE_DIR, CorrespondenceReader, PairReader

_lock = threading.Lock()
_readers: dict[tuple[str, str], PairReader] = {}
_correspondence: dict[str, CorrespondenceReader] = {}
_priorities: dict[str, np.ndarray] = {}


class PairNotFound(KeyError):
    pass


class CorrespondenceNotFound(KeyError):
    pass


def available(pair_id: str) -> list[str]:
    """Metrics computed for this pair. Correspondence is not one of them."""
    directory = config.PAIRS_DIR / pair_id
    if not directory.is_dir():
        return []
    return sorted(
        p.name
        for p in directory.iterdir()
        if p.name != CORRESPONDENCE_DIR and (p / "meta.json").exists()
    )


def has_correspondence(pair_id: str) -> bool:
    return (config.PAIRS_DIR / pair_id / CORRESPONDENCE_DIR / "meta.json").exists()


def get_correspondence(pair_id: str) -> CorrespondenceReader:
    with _lock:
        cached = _correspondence.get(pair_id)
    if cached is not None:
        return cached

    directory = config.PAIRS_DIR / pair_id / CORRESPONDENCE_DIR
    if not (directory / "meta.json").exists():
        raise CorrespondenceNotFound(pair_id)
    reader = CorrespondenceReader(directory)
    with _lock:
        return _correspondence.setdefault(pair_id, reader)


def get_pair(pair_id: str, metric: str) -> PairReader:
    key = (pair_id, metric)
    with _lock:
        cached = _readers.get(key)
    if cached is not None:
        return cached

    directory = config.PAIRS_DIR / pair_id / metric
    if metric == CORRESPONDENCE_DIR or not (directory / "meta.json").exists():
        raise PairNotFound(f"{pair_id}/{metric}")
    reader = PairReader(directory)
    with _lock:
        return _readers.setdefault(key, reader)


def divergence_priority_for(pair_id: str, side: str, parent) -> np.ndarray:
    """Cached ``order=difference`` priority for one side of a pair.

    Keyed by pair and side only — **not** by metric. The ranking comes from
    correspondence, which every metric shares, so switching metric does not
    invalidate it and a metric with no per-node columns still supports the
    navigation.
    """
    from ..trees.summarise import divergence_priority

    key = f"{pair_id}/{side}"
    with _lock:
        cached = _priorities.get(key)
    if cached is not None:
        return cached

    similarity = np.asarray(get_correspondence(pair_id).column(side, "similarity"))
    value = divergence_priority(similarity, parent)
    with _lock:
        return _priorities.setdefault(key, value)


def reset_cache() -> None:
    with _lock:
        _readers.clear()
        _correspondence.clear()
        _priorities.clear()
