"""The on-disk columnar tree store.

One directory per tree, one file per column, plus a JSON header. Reading is
``np.memmap``: the kernel pages in only the bytes a request actually touches, so
serving a 200-node slice of a 56k-node tree reads roughly 200 nodes' worth of
each column rather than the whole file. Nothing is deserialised on startup and
nothing is held in the process heap between requests.

Why raw columns rather than Parquet, HDF5 or a database
-------------------------------------------------------
The access pattern is a *contiguous index range* per column, decided by the
pre-order interval encoding. That is the one thing a flat memory-mapped array
does perfectly and with no dependency. Parquet's row groups and compression both
work against random range access; HDF5 adds a large native dependency for the
same result; a relational store would index rows that are already addressed by
position. The format is deliberately boring: a reader in any language is a
``mmap`` plus a dtype.

Size, measured on the real trees: **26 bytes per node** of topology
(4 + 4 + 2 + 4 + 4 for the numeric columns, ~8 for labels). Both vibrio trees
together are under 1.5 MB. Storage is not the constraint here; computation is.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from .newick import NO_PARENT, TreeArrays

#: Bumped when the on-disk layout changes in a way a reader must notice.
FORMAT_VERSION = 1

#: Column name -> dtype. The single source of truth for the file set: both the
#: writer and the reader iterate this, so they cannot drift apart.
COLUMNS: dict[str, np.dtype] = {
    "parent": np.dtype(np.uint32),
    "subtree_end": np.dtype(np.uint32),
    "depth": np.dtype(np.uint16),
    "leaf_count": np.dtype(np.uint32),
    "branch_len": np.dtype(np.float32),
}

_LABELS_BIN = "labels.bin"
_LABEL_OFFSETS = "label_offsets.u32"
_META = "meta.json"


def _column_path(directory: Path, name: str) -> Path:
    return directory / f"{name}.{COLUMNS[name].name}"


@dataclass(frozen=True, slots=True)
class TreeMeta:
    """The JSON header. Small enough to read on every request."""

    id: str
    species: str
    method: str
    source: str
    n_nodes: int
    n_leaves: int
    max_depth: int
    #: Unary internal nodes removed at ingest. Non-zero means the stored
    #: pre-order indices are this store's canonical form, not offsets into the
    #: source file. See trees/normalise.py.
    suppressed_unary: int = 0
    format_version: int = FORMAT_VERSION
    created: str = ""

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "species": self.species,
            "method": self.method,
            "source": self.source,
            "n_nodes": self.n_nodes,
            "n_leaves": self.n_leaves,
            "max_depth": self.max_depth,
            "suppressed_unary": self.suppressed_unary,
            "format_version": self.format_version,
            "created": self.created,
        }

    @staticmethod
    def from_json(raw: dict) -> "TreeMeta":
        return TreeMeta(
            id=raw["id"],
            species=raw["species"],
            method=raw["method"],
            source=raw.get("source", ""),
            n_nodes=raw["n_nodes"],
            n_leaves=raw["n_leaves"],
            max_depth=raw["max_depth"],
            suppressed_unary=raw.get("suppressed_unary", 0),
            format_version=raw.get("format_version", 0),
            created=raw.get("created", ""),
        )


class TreeReader:
    """Memory-mapped read access to one stored tree.

    Columns are mapped lazily: a request that only needs ``subtree_end`` and
    ``leaf_count`` never touches the branch-length or label files.
    """

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        meta_path = self.directory / _META
        if not meta_path.exists():
            raise FileNotFoundError(f"no tree store at {self.directory}")
        self.meta = TreeMeta.from_json(json.loads(meta_path.read_text()))
        if self.meta.format_version != FORMAT_VERSION:
            raise ValueError(
                f"{self.directory} is format {self.meta.format_version}, "
                f"this build reads {FORMAT_VERSION}; re-run ingestion"
            )
        self._columns: dict[str, np.ndarray] = {}
        self._label_bytes: np.ndarray | None = None
        self._label_offsets: np.ndarray | None = None

    def column(self, name: str) -> np.ndarray:
        cached = self._columns.get(name)
        if cached is None:
            cached = np.memmap(
                _column_path(self.directory, name),
                dtype=COLUMNS[name],
                mode="r",
                shape=(self.meta.n_nodes,),
            )
            self._columns[name] = cached
        return cached

    @property
    def parent(self) -> np.ndarray:
        return self.column("parent")

    @property
    def subtree_end(self) -> np.ndarray:
        return self.column("subtree_end")

    @property
    def depth(self) -> np.ndarray:
        return self.column("depth")

    @property
    def leaf_count(self) -> np.ndarray:
        return self.column("leaf_count")

    @property
    def branch_len(self) -> np.ndarray:
        return self.column("branch_len")

    def _labels_mapped(self) -> tuple[np.ndarray, np.ndarray]:
        if self._label_bytes is None:
            self._label_bytes = np.memmap(
                self.directory / _LABELS_BIN, dtype=np.uint8, mode="r"
            )
            self._label_offsets = np.memmap(
                self.directory / _LABEL_OFFSETS,
                dtype=np.uint32,
                mode="r",
                shape=(self.meta.n_nodes + 1,),
            )
        assert self._label_offsets is not None
        return self._label_bytes, self._label_offsets

    def label(self, i: int) -> str:
        """One label, without materialising the rest.

        This is the point of the offsets file: a slice of 200 nodes decodes 200
        labels, not 56,000.
        """
        data, offsets = self._labels_mapped()
        return bytes(data[offsets[i] : offsets[i + 1]]).decode("utf-8")

    def labels(self, start: int = 0, end: int | None = None) -> list[str]:
        """Labels for the pre-order range ``[start, end)``."""
        data, offsets = self._labels_mapped()
        stop = self.meta.n_nodes if end is None else end
        blob = bytes(data[offsets[start] : offsets[stop]])
        base = int(offsets[start])
        return [
            blob[int(offsets[i]) - base : int(offsets[i + 1]) - base].decode("utf-8")
            for i in range(start, stop)
        ]

    # --- per-node access ---------------------------------------------------
    #
    # Slicing touches a few hundred nodes out of hundreds of thousands, so it
    # asks per node rather than taking whole columns. For this store that is a
    # plain array index; for the succinct store it is a few bit-vector
    # operations. Both answer the same questions, which is what lets one
    # summariser serve either.

    def subtree_end_of(self, i: int) -> int:
        return int(self.subtree_end[i])

    def leaf_count_of(self, i: int) -> int:
        return int(self.leaf_count[i])

    def branch_len_of(self, i: int) -> float:
        return float(self.branch_len[i])

    def parent_of(self, i: int) -> int:
        return int(self.parent[i])

    def is_leaf(self, i: int) -> bool:
        return bool(self.subtree_end[i] == i + 1)

    def to_arrays(self) -> TreeArrays:
        """Materialise everything. For tests and offline work, not for requests."""
        return TreeArrays(
            parent=np.asarray(self.parent),
            subtree_end=np.asarray(self.subtree_end),
            depth=np.asarray(self.depth),
            leaf_count=np.asarray(self.leaf_count),
            branch_len=np.asarray(self.branch_len),
            labels=self.labels(),
        )


def write_tree(directory: Path, arrays: TreeArrays, meta: TreeMeta) -> TreeMeta:
    """Write one tree's columns and header. Overwrites in place."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    for name, dtype in COLUMNS.items():
        values = getattr(arrays, name)
        if values.shape[0] != arrays.n_nodes:
            raise ValueError(f"column {name} has {values.shape[0]} rows, expected {arrays.n_nodes}")
        values.astype(dtype, copy=False).tofile(_column_path(directory, name))

    encoded = [label.encode("utf-8") for label in arrays.labels]
    offsets = np.zeros(len(encoded) + 1, dtype=np.uint32)
    running = 0
    for i, blob in enumerate(encoded):
        running += len(blob)
        offsets[i + 1] = running
    (directory / _LABELS_BIN).write_bytes(b"".join(encoded))
    offsets.tofile(directory / _LABEL_OFFSETS)

    stamped = TreeMeta(
        id=meta.id,
        species=meta.species,
        method=meta.method,
        source=meta.source,
        n_nodes=arrays.n_nodes,
        n_leaves=arrays.n_leaves,
        max_depth=arrays.max_depth,
        suppressed_unary=meta.suppressed_unary,
        format_version=FORMAT_VERSION,
        created=meta.created or datetime.now(UTC).isoformat(timespec="seconds"),
    )
    (directory / _META).write_text(json.dumps(stamped.to_json(), indent=2) + "\n")
    return stamped


def read_tree(directory: Path) -> TreeReader:
    return TreeReader(directory)


def store_bytes(directory: Path) -> int:
    """Total bytes on disk for one stored tree — used to report B/node."""
    return sum(p.stat().st_size for p in Path(directory).iterdir() if p.is_file())


__all__ = [
    "COLUMNS",
    "FORMAT_VERSION",
    "NO_PARENT",
    "TreeMeta",
    "TreeReader",
    "read_tree",
    "store_bytes",
    "write_tree",
]
