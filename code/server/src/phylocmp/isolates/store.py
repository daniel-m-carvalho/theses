"""On-disk store for one species' isolate metadata.

Same shape as the tree and comparison stores (§1.5): flat dictionary-encoded
columns, memory mapped, plus a JSON header. Two things are specific to this
data.

**Rows are sorted by ST and indexed by range.** An ST maps to a contiguous run
of rows, so fetching every isolate for a leaf is a slice -- the same trick the
interval encoding plays for subtrees. Up to 312 isolates share one ST, and the
join is one-to-many in general.

**Values are stored jointly, never as per-key counts.** Marginal counts cannot
answer an AND query: knowing 254 isolates are from Bangladesh and 30 are of
human source says nothing about how many are both. Keeping the row intact is
the only representation that can answer a filter composed of several keys, and
it is why this is a row store with dictionary-encoded columns rather than a
pile of precomputed histograms.

**Species is part of the identity of every store.** ST numbering restarts per
species, so ST 11 is a different organism in vibrio and in clostridium (§1.7).
There is one store per species and no shared namespace.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

FORMAT_VERSION = 1
_META = "meta.json"
_ST_LABELS = "st_labels.txt"
_ST_OFFSETS = "st_offsets.u32"

#: Reserved dictionary code for a blank cell. Real values start at 1, so a
#: missing value is distinguishable from the first value of a column -- the
#: kind of collision that turns "unknown country" into "Afghanistan".
MISSING = 0


def code_dtype(n_values: int) -> np.dtype:
    """The narrowest unsigned type holding ``n_values`` codes plus MISSING."""
    if n_values + 1 <= 2**8:
        return np.dtype(np.uint8)
    if n_values + 1 <= 2**16:
        return np.dtype(np.uint16)
    return np.dtype(np.uint32)


@dataclass(frozen=True, slots=True)
class FacetMeta:
    """One queryable column."""

    name: str
    slug: str
    dtype: str
    n_distinct: int
    n_missing: int
    segmentable: bool
    #: Dictionary, in code order: values[k] has code k + 1.
    values: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class IsolateMeta:
    species: str
    source: str
    n_rows: int
    n_sequence_types: int
    facets: list[FacetMeta]
    format_version: int = FORMAT_VERSION
    created: str = ""

    @property
    def facet_by_name(self) -> dict[str, FacetMeta]:
        return {f.name: f for f in self.facets}


class IsolateReader:
    """Memory-mapped read access to one species' isolate store."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        raw = json.loads((self.directory / _META).read_text())
        if raw.get("format_version") != FORMAT_VERSION:
            raise ValueError(
                f"{self.directory} is format {raw.get('format_version')}, "
                f"this build reads {FORMAT_VERSION}; re-run ingestion"
            )
        self.meta = IsolateMeta(
            species=raw["species"], source=raw["source"], n_rows=raw["n_rows"],
            n_sequence_types=raw["n_sequence_types"],
            facets=[FacetMeta(**f) for f in raw["facets"]],
            format_version=raw["format_version"], created=raw.get("created", ""),
        )
        self._columns: dict[str, np.ndarray] = {}
        self._ranges: dict[str, tuple[int, int]] | None = None

    def column(self, name: str) -> np.ndarray:
        facet = self.meta.facet_by_name.get(name)
        if facet is None:
            raise KeyError(name)
        if name not in self._columns:
            self._columns[name] = np.memmap(
                self.directory / f"col_{facet.slug}.{facet.dtype}",
                dtype=np.dtype(facet.dtype), mode="r", shape=(self.meta.n_rows,),
            )
        return self._columns[name]

    def ranges(self) -> dict[str, tuple[int, int]]:
        """ST -> half-open row range, built once per process.

        A dict rather than a binary search: sequence types are strings, not
        integers (the exports contain ``NaN``, ``-2``, ``-14`` and friends where
        no type was assigned), and 31k Python strings cost little next to the
        certainty of exact matching against a tree's leaf labels.
        """
        if self._ranges is None:
            labels = (self.directory / _ST_LABELS).read_text(encoding="utf-8").splitlines()
            offsets = np.fromfile(self.directory / _ST_OFFSETS, dtype=np.uint32)
            self._ranges = {
                label: (int(offsets[i]), int(offsets[i + 1]))
                for i, label in enumerate(labels)
            }
        return self._ranges

    def rows_for(self, sequence_type: str) -> tuple[int, int]:
        """Row range for one ST, or an empty range if it has no isolates.

        Empty is normal, not exceptional: 3.9% of vibrio leaves and 10.9% of
        clostridium leaves have no isolate rows at all.
        """
        return self.ranges().get(sequence_type, (0, 0))

    def code_of(self, facet: str, value: str) -> int | None:
        meta = self.meta.facet_by_name[facet]
        try:
            return meta.values.index(value) + 1
        except ValueError:
            return None


def write_isolates(directory: Path, meta: IsolateMeta, columns: dict[str, np.ndarray],
                   st_labels: list[str], st_offsets: np.ndarray) -> IsolateMeta:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    for facet in meta.facets:
        values = columns[facet.name]
        if values.shape[0] != meta.n_rows:
            raise ValueError(f"column {facet.name} has {values.shape[0]} rows, expected {meta.n_rows}")
        values.astype(np.dtype(facet.dtype), copy=False).tofile(
            directory / f"col_{facet.slug}.{facet.dtype}"
        )

    (directory / _ST_LABELS).write_text("\n".join(st_labels), encoding="utf-8")
    st_offsets.astype(np.uint32, copy=False).tofile(directory / _ST_OFFSETS)
    (directory / _META).write_text(
        json.dumps(
            {
                "species": meta.species, "source": meta.source,
                "n_rows": meta.n_rows, "n_sequence_types": meta.n_sequence_types,
                "facets": [
                    {
                        "name": f.name, "slug": f.slug, "dtype": f.dtype,
                        "n_distinct": f.n_distinct, "n_missing": f.n_missing,
                        "segmentable": f.segmentable, "values": f.values,
                    }
                    for f in meta.facets
                ],
                "format_version": FORMAT_VERSION, "created": meta.created,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    return meta


def read_isolates(directory: Path) -> IsolateReader:
    return IsolateReader(directory)
