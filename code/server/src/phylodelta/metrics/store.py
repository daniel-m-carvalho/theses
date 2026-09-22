"""On-disk stores for a computed comparison.

Two directories per pair, because the two things have different lifetimes and
different owners:

    store/pairs/{pair}/correspondence/   similarity, corresponds  — shared
    store/pairs/{pair}/{metric}/         whatever that metric declared

**Correspondence is written once per pair**, not once per metric. It is the
expensive half (the best-match search is 12.6 s of the 13 s a pair takes) and it
is identical whichever distance is being computed, so computing it per metric
would multiply the cost of adding one. It also means ``order=difference``
navigation, which ranks by ``similarity``, is metric-independent.

**A metric's directory holds only what that metric produced.** Zero columns is
valid; a geodesic distance contributes a number and nothing per node, and is
still fully usable because the client colours from correspondence.

Cost, measured on the vibrio pair: correspondence is 8 B/node/side
(4 similarity + 4 corresponds) and RF adds 1 B/node/side (``exact``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from ..trees.correspondence import Correspondence, CorrespondenceSide
from ..trees.newick import TreeArrays
from .columns import ColumnReader, read_header, write_side
from .contract import MetricResult, MetricSide

#: Bumped when either on-disk layout changes in a way a reader must notice.
FORMAT_VERSION = 2

CORRESPONDENCE_DIR = "correspondence"
_META = "meta.json"


def _stamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _write_header(directory: Path, payload: dict) -> None:
    (Path(directory) / _META).write_text(
        json.dumps(payload, indent=2, default=str) + "\n"
    )


def _check_version(raw: dict, directory: Path) -> None:
    if raw.get("format_version") != FORMAT_VERSION:
        raise ValueError(
            f"{directory} is format {raw.get('format_version')}, this build reads "
            f"{FORMAT_VERSION}; recompute the pair"
        )


# --- correspondence --------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CorrespondenceMeta:
    pair_id: str
    left: str
    right: str
    n_left: int
    n_right: int
    notes: dict = field(default_factory=dict)
    created: str = ""


class CorrespondenceReader:
    """Memory-mapped read access to one pair's correspondence."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        raw = read_header(self.directory)
        _check_version(raw, self.directory)
        self.meta = CorrespondenceMeta(
            pair_id=raw["pair_id"], left=raw["left"], right=raw["right"],
            n_left=raw["n_left"], n_right=raw["n_right"],
            notes=raw.get("notes", {}), created=raw.get("created", ""),
        )
        self.reader = ColumnReader(
            directory=self.directory,
            schema=raw["schema"],
            sizes={"left": raw["n_left"], "right": raw["n_right"]},
        )

    def column(self, side: str, column: str) -> np.ndarray:
        return self.reader.column(side, column)

    def slice(self, side: str, start: int, end: int) -> dict[str, np.ndarray]:
        return self.reader.slice(side, start, end)


def write_correspondence(
    directory: Path,
    correspondence: Correspondence,
    pair_id: str,
    left_id: str,
    right_id: str,
    left: TreeArrays,
    right: TreeArrays,
    notes: dict | None = None,
) -> CorrespondenceMeta:
    directory = Path(directory)
    schema = {
        "left": write_side(
            directory, "left",
            {"similarity": correspondence.left.similarity,
             "corresponds": correspondence.left.corresponds},
            left.n_nodes,
        ),
        "right": write_side(
            directory, "right",
            {"similarity": correspondence.right.similarity,
             "corresponds": correspondence.right.corresponds},
            right.n_nodes,
        ),
    }
    meta = CorrespondenceMeta(
        pair_id=pair_id, left=left_id, right=right_id,
        n_left=left.n_nodes, n_right=right.n_nodes,
        notes=dict(notes or {}), created=_stamp(),
    )
    _write_header(directory, {
        "pair_id": meta.pair_id, "left": meta.left, "right": meta.right,
        "n_left": meta.n_left, "n_right": meta.n_right,
        "schema": schema, "notes": meta.notes,
        "format_version": FORMAT_VERSION, "created": meta.created,
    })
    return meta


def read_correspondence(directory: Path) -> CorrespondenceReader:
    return CorrespondenceReader(directory)


# --- a metric's own columns ------------------------------------------------


@dataclass(frozen=True, slots=True)
class PairMeta:
    pair_id: str
    metric: str
    left: str
    right: str
    n_left: int
    n_right: int
    summary: dict = field(default_factory=dict)
    notes: dict = field(default_factory=dict)
    created: str = ""


class PairReader:
    """Memory-mapped read access to one metric's contribution for a pair."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        raw = read_header(self.directory)
        _check_version(raw, self.directory)
        self.meta = PairMeta(
            pair_id=raw["pair_id"], metric=raw["metric"],
            left=raw["left"], right=raw["right"],
            n_left=raw["n_left"], n_right=raw["n_right"],
            summary=raw.get("summary", {}), notes=raw.get("notes", {}),
            created=raw.get("created", ""),
        )
        self.reader = ColumnReader(
            directory=self.directory,
            schema=raw.get("schema", {}),
            sizes={"left": raw["n_left"], "right": raw["n_right"]},
        )

    def columns(self, side: str) -> list[str]:
        return self.reader.columns(side)

    def column(self, side: str, column: str) -> np.ndarray:
        return self.reader.column(side, column)

    def slice(self, side: str, start: int, end: int) -> dict[str, np.ndarray]:
        return self.reader.slice(side, start, end)


def write_pair(
    directory: Path,
    result: MetricResult,
    pair_id: str,
    left_id: str,
    right_id: str,
    left: TreeArrays,
    right: TreeArrays,
) -> PairMeta:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    schema: dict[str, dict[str, str]] = {}
    for side, values, arrays in (
        ("left", result.left, left),
        ("right", result.right, right),
    ):
        # None and MetricSide({}) both mean "nothing per node". That is a
        # supported result, not a failure: see contract.py.
        columns = values.columns if values is not None else {}
        schema[side] = write_side(directory, side, columns, arrays.n_nodes)

    meta = PairMeta(
        pair_id=pair_id, metric=result.name, left=left_id, right=right_id,
        n_left=left.n_nodes, n_right=right.n_nodes,
        summary=dict(result.summary), notes=dict(result.notes), created=_stamp(),
    )
    _write_header(directory, {
        "pair_id": meta.pair_id, "metric": meta.metric,
        "left": meta.left, "right": meta.right,
        "n_left": meta.n_left, "n_right": meta.n_right,
        "schema": schema, "summary": meta.summary, "notes": meta.notes,
        "format_version": FORMAT_VERSION, "created": meta.created,
    })
    return meta


def read_pair(directory: Path) -> PairReader:
    return PairReader(directory)


__all__ = [
    "CORRESPONDENCE_DIR",
    "FORMAT_VERSION",
    "CorrespondenceMeta",
    "CorrespondenceReader",
    "PairMeta",
    "PairReader",
    "read_correspondence",
    "read_pair",
    "write_correspondence",
    "write_pair",
]
