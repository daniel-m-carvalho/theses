"""A tree stored as balanced parentheses, following the paper's representation.

The same tree as ``trees.store``, in the form Branco, Vaz & Francisco (2024)
use: a bit vector of 2 bits per node, plus rank/select support. What it holds is
*topology*; labels and branch lengths sit beside it in ordinary columns, because
they are data the succinct structure has no notion of and the API must serve.

Measured on the vibrio trees (§12.3), and stated carefully because the flattering
number is easy to quote by mistake:

* topology alone: **0.34 B/node**, against 14.00 B/node of columns — 41x
* like-for-like, counting labels and branch lengths that must be served either
  way: **6.34 B/node against 24.70** — **3.9x**

The second is the honest figure. §2.1 predicted ~4x before any of it was built.

What this costs is time: the columnar store *holds* answers where this one
*computes* them (`num_leaves` over 35,291 nodes is 3.2 ms against 0.2 ms). That
is the paper's own reported trade-off, reproduced on a dataset it did not use —
and at slice scale, a few hundred nodes, it is invisible.

Serving is per node, never by column
------------------------------------
``Summariser`` asks ``subtree_end_of(i)`` and friends rather than taking whole
arrays, which is what makes this store usable at all: handing over an array
would mean decompressing an entire tree to serve a few hundred nodes of it.
Both stores answer the same questions, so one summariser serves either and the
slices can be compared byte for byte.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from .native import extension
from .newick import NO_PARENT, TreeArrays
from .store import TreeMeta

FORMAT_VERSION = 1

_BP = "topology.bp"
_BRANCH = "branch_len.float32"
_LABELS = "labels.bin"
_LABEL_OFFSETS = "label_offsets.u32"
_META = "meta.json"


class NativeRequired(RuntimeError):
    """The succinct store needs the native extension; the columnar one does not."""


def _require_extension():
    module = extension()
    if module is None:
        raise NativeRequired(
            "the succinct store needs the native extension; run native/build.sh, "
            "or use the columnar store, which needs no compiler"
        )
    return module


def to_balanced_parens(arrays: TreeArrays) -> str:
    """Pre-order balanced parentheses: '(' on entering a node, ')' on leaving."""
    end = np.asarray(arrays.subtree_end)
    out: list[str] = []
    stack: list[tuple[bool, int]] = [(True, 0)]
    while stack:
        entering, i = stack.pop()
        if not entering:
            out.append(")")
            continue
        out.append("(")
        stack.append((False, i))
        children, c = [], i + 1
        while c < int(end[i]):
            children.append(c)
            c = int(end[c])
        for child in reversed(children):
            stack.append((True, child))
    return "".join(out)


class SuccinctTreeReader:
    """Read access to a tree stored as balanced parentheses.

    Presents the same per-node interface as ``store.TreeReader``, so the
    summariser and the API do not know which store they are reading.
    """

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        raw = json.loads((self.directory / _META).read_text())
        if raw.get("format_version") != FORMAT_VERSION:
            raise ValueError(
                f"{self.directory} is format {raw.get('format_version')}, this "
                f"build reads {FORMAT_VERSION}; re-run ingestion"
            )
        self.meta = TreeMeta.from_json(raw)
        module = _require_extension()
        self._tree = module.BpTree.load(str(self.directory / _BP))
        self._branch: np.ndarray | None = None
        self._label_bytes: np.ndarray | None = None
        self._label_offsets: np.ndarray | None = None
        # sdsl works in bit-vector positions; this store's node ids are
        # pre-order indices, as everything else in the project is (§1.1).
        self._position: dict[int, int] = {}

    # --- position mapping --------------------------------------------------

    def _pos(self, i: int) -> int:
        """Bit-vector position of node ``i``. sdsl's pre-order is 1-based."""
        cached = self._position.get(i)
        if cached is None:
            cached = self._tree.select(i + 1)
            self._position[i] = cached
        return cached

    # --- per-node access ---------------------------------------------------

    def subtree_end_of(self, i: int) -> int:
        # The interval's exclusive end is this node's index plus the number of
        # nodes in its subtree — which is what cluster_size counts.
        return i + self._tree.cluster_size(self._pos(i))

    def leaf_count_of(self, i: int) -> int:
        return self._tree.num_leaves(self._pos(i))

    def branch_len_of(self, i: int) -> float:
        return float(self.branch_len[i])

    def parent_of(self, i: int) -> int:
        if i == 0:
            return int(NO_PARENT)
        return self._tree.preorder(self._tree.enclose(self._pos(i))) - 1

    def is_leaf(self, i: int) -> bool:
        return self._tree.is_leaf(self._pos(i))

    # --- columns that sit beside the topology ------------------------------

    @property
    def branch_len(self) -> np.ndarray:
        if self._branch is None:
            self._branch = np.memmap(
                self.directory / _BRANCH, dtype=np.float32, mode="r",
                shape=(self.meta.n_nodes,),
            )
        return self._branch

    def _labels_mapped(self) -> tuple[np.ndarray, np.ndarray]:
        if self._label_bytes is None:
            self._label_bytes = np.memmap(
                self.directory / _LABELS, dtype=np.uint8, mode="r"
            )
            self._label_offsets = np.memmap(
                self.directory / _LABEL_OFFSETS, dtype=np.uint32, mode="r",
                shape=(self.meta.n_nodes + 1,),
            )
        assert self._label_offsets is not None
        return self._label_bytes, self._label_offsets

    def label(self, i: int) -> str:
        data, offsets = self._labels_mapped()
        return bytes(data[offsets[i] : offsets[i + 1]]).decode("utf-8")

    def labels(self, start: int = 0, end: int | None = None) -> list[str]:
        data, offsets = self._labels_mapped()
        stop = self.meta.n_nodes if end is None else end
        blob = bytes(data[offsets[start] : offsets[stop]])
        base = int(offsets[start])
        return [
            blob[int(offsets[k]) - base : int(offsets[k + 1]) - base].decode("utf-8")
            for k in range(start, stop)
        ]

    # --- whole columns, materialised on demand -----------------------------
    #
    # A few operations are genuinely whole-tree — `divergence_priority` folds
    # over every node once per pair, and is cached. They are served by
    # reconstructing the column, which is honest about the cost rather than
    # pretending random access is free.

    @property
    def subtree_end(self) -> np.ndarray:
        return np.fromiter(
            (self.subtree_end_of(i) for i in range(self.meta.n_nodes)),
            dtype=np.uint32, count=self.meta.n_nodes,
        )

    @property
    def leaf_count(self) -> np.ndarray:
        return np.fromiter(
            (self.leaf_count_of(i) for i in range(self.meta.n_nodes)),
            dtype=np.uint32, count=self.meta.n_nodes,
        )

    @property
    def parent(self) -> np.ndarray:
        return np.fromiter(
            (self.parent_of(i) for i in range(self.meta.n_nodes)),
            dtype=np.uint32, count=self.meta.n_nodes,
        )

    def size_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.directory.iterdir() if p.is_file())


def write_succinct_tree(directory: Path, arrays: TreeArrays, meta: TreeMeta) -> TreeMeta:
    """Write one tree as balanced parentheses, plus the columns beside it."""
    module = _require_extension()
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    module.BpTree(to_balanced_parens(arrays)).save(str(directory / _BP))
    np.asarray(arrays.branch_len).astype(np.float32, copy=False).tofile(
        directory / _BRANCH
    )

    encoded = [label.encode("utf-8") for label in arrays.labels]
    offsets = np.zeros(len(encoded) + 1, dtype=np.uint32)
    running = 0
    for i, blob in enumerate(encoded):
        running += len(blob)
        offsets[i + 1] = running
    (directory / _LABELS).write_bytes(b"".join(encoded))
    offsets.tofile(directory / _LABEL_OFFSETS)

    stamped = TreeMeta(
        id=meta.id, species=meta.species, method=meta.method, source=meta.source,
        n_nodes=arrays.n_nodes, n_leaves=arrays.n_leaves, max_depth=arrays.max_depth,
        suppressed_unary=meta.suppressed_unary,
        resolved_root=meta.resolved_root,
        format_version=FORMAT_VERSION,
        created=meta.created or datetime.now(UTC).isoformat(timespec="seconds"),
    )
    (directory / _META).write_text(json.dumps(stamped.to_json(), indent=2) + "\n")
    return stamped


def read_succinct_tree(directory: Path) -> SuccinctTreeReader:
    return SuccinctTreeReader(directory)
