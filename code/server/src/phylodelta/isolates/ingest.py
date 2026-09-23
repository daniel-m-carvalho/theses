"""Isolate TSV -> dictionary-encoded columns, sorted and indexed by ST.

This is the largest input the backend handles -- 8.8 MB for vibrio and 12 MB for
clostridium, against 1.3 MB for both vibrio trees. Metadata, not topology, is
the dominant payload, which is why it is served filtered and per visible leaf
rather than shipped.
"""

from __future__ import annotations

import csv
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from .schema import JOIN_COLUMN, is_facet, is_segmentable, slug
from .store import MISSING, FacetMeta, IsolateMeta, code_dtype, write_isolates

# EnteroBase headers embed long parenthesised field lists; give csv room.
csv.field_size_limit(10**7)


def _read_tsv(path: Path) -> tuple[list[str], list[list[str]]]:
    with open(path, newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle, delimiter="\t")
        header = next(reader)
        rows = [row for row in reader if any(cell.strip() for cell in row)]
    return header, rows


def ingest_species(species: str, path: Path, directory: Path) -> IsolateMeta:
    header, rows = _read_tsv(path)
    if JOIN_COLUMN not in header:
        raise ValueError(f"{path.name} has no {JOIN_COLUMN!r} column; cannot join to a tree")
    join_at = header.index(JOIN_COLUMN)

    def cell(row: list[str], i: int) -> str:
        return row[i].strip() if i < len(row) else ""

    # Sort by ST so that one sequence type is a contiguous run of rows. Sorted
    # by string, because sequence types are not all integers: the exports carry
    # NaN, -2, -3, -14 and similar where none was assigned.
    order = sorted(range(len(rows)), key=lambda r: cell(rows[r], join_at))
    rows = [rows[r] for r in order]

    facets: list[FacetMeta] = []
    columns: dict[str, np.ndarray] = {}
    for i, name in enumerate(header):
        distinct = {cell(row, i) for row in rows} - {""}
        if not is_facet(name, len(distinct)):
            continue
        values = sorted(distinct)
        code_of = {value: k + 1 for k, value in enumerate(values)}
        dtype = code_dtype(len(values))
        codes = np.fromiter(
            (code_of.get(cell(row, i), MISSING) for row in rows),
            dtype=dtype, count=len(rows),
        )
        facets.append(
            FacetMeta(
                name=name, slug=slug(name), dtype=dtype.name,
                n_distinct=len(values),
                n_missing=int((codes == MISSING).sum()),
                segmentable=is_segmentable(len(values)),
                values=values,
            )
        )
        columns[name] = codes

    # ST -> row range. Rows are already grouped by the sort above.
    st_labels: list[str] = []
    offsets: list[int] = [0]
    previous = None
    for index, row in enumerate(rows):
        current = cell(row, join_at)
        if current != previous:
            if previous is not None:
                offsets.append(index)
            st_labels.append(current)
            previous = current
    offsets.append(len(rows))

    meta = IsolateMeta(
        species=species, source=path.name, n_rows=len(rows),
        n_sequence_types=len(st_labels), facets=facets,
        created=datetime.now(UTC).isoformat(timespec="seconds"),
    )
    return write_isolates(
        directory, meta, columns, st_labels, np.asarray(offsets, dtype=np.uint32)
    )


def ingest_all(datasets_dir: Path | None = None, store_dir: Path | None = None) -> int:
    from .. import catalogue, config, db
    from ..api.identity import SINGLE_OWNER

    sources = catalogue.discover_isolate_sources(datasets_dir)
    if not sources:
        print("no isolate TSVs found", file=sys.stderr)
        return 1

    root = Path(store_dir or config.STORE_DIR) / "isolates"
    with db.using_store(root.parent):
        db.create_schema()
        return _ingest_each(sources, root)


def _ingest_each(sources, root) -> int:
    from .. import db
    from ..api.identity import SINGLE_OWNER

    for species, path in sources.items():
        meta = ingest_species(species, path, root / species)
        db.register_dataset(
            dataset_id=f"isolates-{species}",
            owner_id=SINGLE_OWNER,
            kind=db.DatasetKind.ISOLATES,
            display_name=f"{species} isolates",
            store_path=f"isolates/{species}",
            source_name=meta.source,
        )
        total = sum(p.stat().st_size for p in (root / species).iterdir() if p.is_file())
        source_size = path.stat().st_size
        print(
            f"{species:<14} {meta.n_rows:>7,} isolates  {meta.n_sequence_types:>7,} STs  "
            f"{len(meta.facets):>3} facets  "
            f"{source_size / 1024 / 1024:>5.1f} MB -> {total / 1024 / 1024:>4.1f} MB  "
            f"({source_size / total:.1f}x smaller)"
        )
    return 0
