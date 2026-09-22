"""Isolate metadata: what can be filtered on, and per-leaf composition.

This is the largest input the backend holds — 8.8 MB and 12 MB of TSV against
1.3 MB for both vibrio trees — so none of it is shipped whole. The client asks
about the leaves it is currently showing and receives counts for those.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Path, Query

from ..isolates import registry as isolate_registry
from ..isolates.query import UnknownFacet, UnknownValue, compositions, value_counts
from . import errors
from .routes_meta import API_PREFIX
from .schemas import (
    CompositionRequest,
    CompositionResponse,
    FacetSummary,
    FacetValues,
    IsolateKeys,
    LeafCompositionOut,
    ValueCount,
)

router = APIRouter(prefix=f"{API_PREFIX}/isolates", tags=["isolates"])

#: A slice cannot show more leaves than its budget, and the cap on that is
#: 50,000 (§4.6). Matching it here keeps one request bounded without ever
#: refusing a composition for a slice the client legitimately holds.
MAX_LEAVES = 50_000


def _reader(species: str):
    try:
        return isolate_registry.get_isolates(species)
    except isolate_registry.IsolatesNotFound:
        available = isolate_registry.available_species()
        raise errors.not_found(
            "isolates_not_found",
            f"No isolate store for {species!r}.",
            f"Available: {', '.join(available)}."
            if available
            else "Run `phylocmp ingest-isolates`.",
        ) from None


@router.get("/{species}/keys", response_model=IsolateKeys, summary="Queryable isolate columns")
def isolate_keys(species: str = Path(examples=["vibrio"])) -> IsolateKeys:
    reader = _reader(species)
    return IsolateKeys(
        species=reader.meta.species,
        n_isolates=reader.meta.n_rows,
        n_sequence_types=reader.meta.n_sequence_types,
        source=reader.meta.source,
        facets=[
            FacetSummary(
                name=f.name, n_distinct=f.n_distinct,
                n_missing=f.n_missing, segmentable=f.segmentable,
            )
            for f in reader.meta.facets
        ],
    )


@router.get(
    "/{species}/values",
    response_model=list[FacetValues],
    summary="Distinct values and counts, for populating a filter UI",
)
def isolate_values(
    species: str = Path(examples=["vibrio"]),
    key: list[str] | None = Query(
        None,
        description=(
            "Repeatable. Omit for every facet, which is a large response — "
            "`/keys` reports the value counts, so ask for what you need."
        ),
    ),
) -> list[FacetValues]:
    reader = _reader(species)
    wanted = key or [f.name for f in reader.meta.facets]
    out: list[FacetValues] = []
    for name in wanted:
        try:
            counts = value_counts(reader, name)
        except UnknownFacet:
            raise errors.not_found(
                "key_not_found",
                f"No key {name!r} for {species!r}.",
                f"GET /api/isolates/{species}/keys lists the queryable columns.",
            ) from None
        out.append(
            FacetValues(
                key=name,
                values=[ValueCount(value=s.value, count=s.count) for s in counts],
            )
        )
    return out


@router.post(
    "/{species}/compositions",
    response_model=CompositionResponse,
    summary="Per-leaf isolate composition, filtered",
)
def isolate_compositions(
    species: str = Path(examples=["vibrio"]),
    request: CompositionRequest = Body(...),
) -> CompositionResponse:
    reader = _reader(species)
    if len(request.leaves) > MAX_LEAVES:
        raise errors.unprocessable(
            "too_many_leaves",
            f"{len(request.leaves):,} leaves requested; the limit is {MAX_LEAVES:,}.",
            "Ask for the leaves of one slice at a time.",
        )
    try:
        result = compositions(
            reader, request.leaves, request.segment_by, request.filter
        )
    except UnknownFacet as exc:
        raise errors.not_found(
            "key_not_found",
            f"No key {exc.args[0]!r} for {species!r}.",
            f"GET /api/isolates/{species}/keys lists the queryable columns.",
        ) from None
    except UnknownValue as exc:
        raise errors.unprocessable(
            "unknown_filter_value",
            f"No isolate has {exc.args[0]}. A filter value that matches nothing "
            "is rejected rather than returned as an empty result, because the "
            "two are indistinguishable in the response.",
            f"GET /api/isolates/{species}/values?key=... lists the real values.",
        ) from None

    return CompositionResponse(
        species=reader.meta.species,
        segment_by=request.segment_by,
        filter=request.filter,
        leaves=[
            LeafCompositionOut(
                leaf=c.leaf, total=c.total, available=c.available,
                segments=[ValueCount(value=s.value, count=s.count) for s in c.segments],
            )
            for c in result
        ],
    )
