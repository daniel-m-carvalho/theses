"""Flat per-node column files, shared by the correspondence and metric stores.

Same form as the tree store (§1.5): one file per column per side, memory mapped,
indexed by pre-order position — so a slice of any of these is the same
contiguous range as the slice of topology it accompanies, and they are read
together and shipped aligned index for index.

The column **set** is data, not code. ``meta.json`` records each column's name
and dtype, and readers drive off that. This is what lets a metric declare what
it produces instead of being forced into one shape: a metric with an extra
per-clade signal adds a column, and a metric with nothing to say per node
writes none at all.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

#: Dtypes a column may declare. Deliberately small: these are the widths that
#: earn their place, and an unknown name should fail at write time rather than
#: produce a file nothing can read back.
DTYPES: dict[str, np.dtype] = {
    "float32": np.dtype(np.float32),
    "float64": np.dtype(np.float64),
    "uint8": np.dtype(np.uint8),
    "uint16": np.dtype(np.uint16),
    "uint32": np.dtype(np.uint32),
    "int32": np.dtype(np.int32),
}

SIDES = ("left", "right")


def dtype_of(name: str) -> np.dtype:
    try:
        return DTYPES[name]
    except KeyError:
        raise ValueError(
            f"unknown column dtype {name!r}; known: {sorted(DTYPES)}"
        ) from None


def name_of(dtype: np.dtype) -> str:
    for label, known in DTYPES.items():
        if np.dtype(dtype) == known:
            return label
    raise ValueError(f"dtype {dtype} is not a storable column type")


def column_path(directory: Path, side: str, column: str, dtype_name: str) -> Path:
    return Path(directory) / f"{side}_{column}.{dtype_name}"


def write_side(
    directory: Path, side: str, columns: dict[str, np.ndarray], n_nodes: int
) -> dict[str, str]:
    """Write one side's columns. Returns {column: dtype name} for the header."""
    if side not in SIDES:
        raise ValueError(f"side must be one of {SIDES}, not {side!r}")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    written: dict[str, str] = {}
    for column, values in sorted(columns.items()):
        array = np.asarray(values)
        if array.shape[0] != n_nodes:
            raise ValueError(
                f"column {column!r} covers {array.shape[0]} nodes, tree has {n_nodes}"
            )
        # Booleans are stored as uint8: numpy's bool_ is already one byte, and
        # naming it explicitly keeps the on-disk type readable from any language.
        if array.dtype == np.bool_:
            array = array.astype(np.uint8)
        dtype_name = name_of(array.dtype)
        array.tofile(column_path(directory, side, column, dtype_name))
        written[column] = dtype_name
    return written


@dataclass
class ColumnReader:
    """Memory-mapped access to one directory of per-node columns."""

    directory: Path
    schema: dict[str, dict[str, str]]  # side -> {column: dtype name}
    sizes: dict[str, int]  # side -> n_nodes

    def __post_init__(self) -> None:
        self._cache: dict[tuple[str, str], np.ndarray] = {}

    def columns(self, side: str) -> list[str]:
        return sorted(self.schema.get(side, {}))

    def has(self, side: str, column: str) -> bool:
        return column in self.schema.get(side, {})

    def column(self, side: str, column: str) -> np.ndarray:
        key = (side, column)
        if key not in self._cache:
            dtype_name = self.schema.get(side, {}).get(column)
            if dtype_name is None:
                raise KeyError(
                    f"no column {column!r} for side {side!r} in {self.directory}; "
                    f"present: {self.columns(side)}"
                )
            self._cache[key] = np.memmap(
                column_path(self.directory, side, column, dtype_name),
                dtype=dtype_of(dtype_name),
                mode="r",
                shape=(self.sizes[side],),
            )
        return self._cache[key]

    def slice(self, side: str, start: int, end: int) -> dict[str, np.ndarray]:
        """Every column for the pre-order range ``[start, end)``."""
        return {
            column: np.asarray(self.column(side, column)[start:end])
            for column in self.columns(side)
        }


def read_header(directory: Path, filename: str = "meta.json") -> dict:
    path = Path(directory) / filename
    if not path.exists():
        raise FileNotFoundError(f"no header at {path}")
    return json.loads(path.read_text())
