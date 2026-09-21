"""Open isolate stores once per process (cf. ``trees.registry``)."""

from __future__ import annotations

import threading

from .. import config
from .store import IsolateReader

_lock = threading.Lock()
_readers: dict[str, IsolateReader] = {}


class IsolatesNotFound(KeyError):
    pass


def available_species() -> list[str]:
    root = config.ISOLATES_DIR
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "meta.json").exists())


def get_isolates(species: str) -> IsolateReader:
    with _lock:
        cached = _readers.get(species)
    if cached is not None:
        return cached
    directory = config.ISOLATES_DIR / species
    if not (directory / "meta.json").exists():
        raise IsolatesNotFound(species)
    reader = IsolateReader(directory)
    with _lock:
        return _readers.setdefault(species, reader)


def reset_cache() -> None:
    with _lock:
        _readers.clear()
