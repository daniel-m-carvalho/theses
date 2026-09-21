"""Open stored trees once per process.

``TreeReader`` holds memory maps, not data: the cache costs a few hundred bytes
per tree and lets the kernel's page cache do the real caching, shared across
workers. Nothing here loads a tree into the heap.
"""

from __future__ import annotations

import threading
from pathlib import Path

from .. import config
from .store import TreeReader

_lock = threading.Lock()
_readers: dict[str, TreeReader] = {}


class TreeNotFound(KeyError):
    pass


def _trees_dir() -> Path:
    return config.TREES_DIR


def available_tree_ids() -> list[str]:
    root = _trees_dir()
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "meta.json").exists())


def get_tree(tree_id: str) -> TreeReader:
    with _lock:
        reader = _readers.get(tree_id)
        if reader is not None:
            return reader
    # Built outside the lock: opening is cheap but the first call also validates
    # the header, and a slow disk should not block every other tree's lookup.
    directory = _trees_dir() / tree_id
    if not (directory / "meta.json").exists():
        raise TreeNotFound(tree_id)
    reader = TreeReader(directory)
    with _lock:
        return _readers.setdefault(tree_id, reader)


_leaf_labels: dict[str, frozenset[str]] = {}


def leaf_label_set(tree_id: str) -> frozenset[str]:
    """The tree's leaf labels, decoded once per process.

    Pairing decisions are made on the actual overlap between two trees' labels
    rather than on a rule about species, so this is needed per tree. Decoding
    17.6k labels costs a few milliseconds and the result is small; the mmap it
    reads from is shared anyway.
    """
    cached = _leaf_labels.get(tree_id)
    if cached is not None:
        return cached

    import numpy as np

    reader = get_tree(tree_id)
    end = np.asarray(reader.subtree_end)
    labels = reader.labels()
    is_leaf = end == np.arange(reader.meta.n_nodes) + 1
    result = frozenset(label for label, leaf in zip(labels, is_leaf) if leaf)
    with _lock:
        return _leaf_labels.setdefault(tree_id, result)


def reset_cache() -> None:
    """Drop every open map. Used by tests that rebuild a fixture store."""
    with _lock:
        _readers.clear()
        _leaf_labels.clear()
