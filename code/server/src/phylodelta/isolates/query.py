"""Filtered composition queries over the isolate store.

The shape the frontend needs (settled earlier as "model C"): **one key segments
and colours, the others filter**. A leaf's bar is divided by the segmenting
key's values, counting only isolates that pass every filter.

Filters combine with AND across keys and OR within a key -- "Bangladesh or
India, and human source". That is the query joint tuples exist to answer:
per-key counts could tell you how many isolates are Bangladeshi and how many are
human-source, but never how many are both.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .store import MISSING, IsolateReader


class UnknownFacet(KeyError):
    pass


class UnknownValue(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Segment:
    #: None for isolates whose value for the segmenting key is blank -- a real
    #: and common state (11,699 of 26,629 vibrio rows have no Source Niche), and
    #: distinct from a zero count.
    value: str | None
    count: int


@dataclass(frozen=True, slots=True)
class LeafComposition:
    leaf: str
    #: Isolates for this leaf that passed every filter.
    total: int
    #: Isolates for this leaf before filtering. `total == 0 < available` means
    #: "filtered out"; `available == 0` means the leaf has no isolate data at
    #: all, which is true of 3.9% of vibrio leaves and 10.9% of clostridium's.
    available: int
    segments: list[Segment] = field(default_factory=list)


def resolve_filters(
    reader: IsolateReader, filters: dict[str, list[str]]
) -> dict[str, np.ndarray]:
    """Turn {key: [values]} into {key: allowed codes}, rejecting what it cannot match.

    An unknown value is an error rather than an empty result: silently matching
    nothing would look identical to a filter that is simply very selective, and
    a typo would read as a finding.
    """
    by_name = reader.meta.facet_by_name
    resolved: dict[str, np.ndarray] = {}
    for key, wanted in filters.items():
        facet = by_name.get(key)
        if facet is None:
            raise UnknownFacet(key)
        codes = []
        for value in wanted:
            code = reader.code_of(key, value)
            if code is None:
                raise UnknownValue(f"{key}={value!r}")
            codes.append(code)
        resolved[key] = np.asarray(sorted(set(codes)), dtype=np.int64)
    return resolved


def compositions(
    reader: IsolateReader,
    leaves: list[str],
    segment_by: str,
    filters: dict[str, list[str]] | None = None,
) -> list[LeafComposition]:
    """Per-leaf composition, for the visible leaves only.

    Isolate rows for one sequence type are contiguous (the store is sorted by
    ST), so gathering the rows for a slice's worth of leaves is a handful of
    range reads rather than a scan of 38,597 rows.
    """
    if segment_by not in reader.meta.facet_by_name:
        raise UnknownFacet(segment_by)
    allowed = resolve_filters(reader, filters or {})

    ranges = [reader.rows_for(leaf) for leaf in leaves]
    available = np.asarray([end - start for start, end in ranges], dtype=np.int64)
    if not available.any():
        return [
            LeafComposition(leaf=leaf, total=0, available=0, segments=[])
            for leaf in leaves
        ]

    rows = np.concatenate(
        [np.arange(start, end, dtype=np.int64) for start, end in ranges if end > start]
    )
    leaf_of_row = np.repeat(np.arange(len(leaves), dtype=np.int64), available)

    keep = np.ones(len(rows), dtype=bool)
    for key, codes in allowed.items():
        keep &= np.isin(np.asarray(reader.column(key))[rows], codes)

    rows, leaf_of_row = rows[keep], leaf_of_row[keep]
    segment_codes = np.asarray(reader.column(segment_by))[rows].astype(np.int64)

    # Count (leaf, value) pairs sparsely. A dense table would be
    # len(leaves) x n_distinct, which is wasteful at 5,000 values and most of it
    # zero; only matched rows are touched here.
    values = reader.meta.facet_by_name[segment_by].values
    stride = len(values) + 1
    pairs, counts = np.unique(leaf_of_row * stride + segment_codes, return_counts=True)

    buckets: dict[int, list[Segment]] = {}
    totals = np.zeros(len(leaves), dtype=np.int64)
    for pair, count in zip(pairs.tolist(), counts.tolist()):
        position, code = divmod(pair, stride)
        totals[position] += count
        buckets.setdefault(position, []).append(
            Segment(value=None if code == MISSING else values[code - 1], count=count)
        )

    return [
        LeafComposition(
            leaf=leaf,
            total=int(totals[position]),
            available=int(available[position]),
            segments=sorted(
                buckets.get(position, []),
                key=lambda s: (-s.count, s.value or ""),
            ),
        )
        for position, leaf in enumerate(leaves)
    ]


def value_counts(reader: IsolateReader, key: str) -> list[Segment]:
    """Distinct values of one facet with their isolate counts, commonest first.

    What a filter UI needs to populate itself: the options, and how much data
    sits behind each.
    """
    facet = reader.meta.facet_by_name.get(key)
    if facet is None:
        raise UnknownFacet(key)
    codes = np.asarray(reader.column(key)).astype(np.int64)
    counts = np.bincount(codes, minlength=len(facet.values) + 1)
    out = [
        Segment(value=facet.values[code - 1], count=int(counts[code]))
        for code in range(1, len(facet.values) + 1)
        if counts[code]
    ]
    out.sort(key=lambda s: (-s.count, s.value or ""))
    if counts[MISSING]:
        out.append(Segment(value=None, count=int(counts[MISSING])))
    return out
