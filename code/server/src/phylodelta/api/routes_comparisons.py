"""Serving computed comparisons.

Values are stored indexed by stored-tree pre-order position (§3.4, §3.6), which
is the same index a tree slice reports in ``nodes.id``. Serving values for a
slice is therefore a gather at those positions -- no search, no join, no
recomputation.
"""

from __future__ import annotations

import math

import numpy as np
from fastapi import APIRouter, Path, Query

from ..metrics import registry_pairs
from ..metrics.contract import NO_CORRESPONDENCE
from ..metrics.store import PairReader
from ..trees import registry as tree_registry
from ..trees.summarise import flatten
from . import errors
from .routes_meta import API_PREFIX
from .schemas import ComparisonSlice, ComparisonSummary, ComparisonValues
from .slicing import (
    ORDER_DESCRIPTION,
    Order,
    correspondence_or_404,
    pair_or_404,
    side_of,
    summariser_for,
)

router = APIRouter(prefix=f"{API_PREFIX}/comparisons", tags=["comparisons"])


def values_at(
    pair_id: str, side: str, ids: list[int], metric_reader: PairReader | None = None
) -> ComparisonValues:
    """Gather per-node values at the given stored ids, in that order.

    Composes two sources: the pair's **correspondence**, which every comparison
    has, and the **metric's own columns**, which it may or may not have. A
    metric contributing nothing per node still yields a full response — that is
    the point of the split, and why a scalar-only distance is usable.

    JSON has no NaN and no sentinel integers, so "this node has no counterpart"
    becomes ``null`` on both the similarity and the correspondence. Emitting a
    raw NaN would produce a document many parsers reject, and emitting
    0xFFFFFFFF would look like a valid node id.
    """
    index = np.asarray(ids, dtype=np.int64)
    correspondence = correspondence_or_404(pair_id)
    similarity = np.asarray(correspondence.column(side, "similarity"))[index]
    corresponds = np.asarray(correspondence.column(side, "corresponds"))[index]

    columns: dict[str, list] = {}
    if metric_reader is not None:
        for name in metric_reader.columns(side):
            values = np.asarray(metric_reader.column(side, name))[index]
            if name == "exact" or values.dtype == np.uint8:
                columns[name] = [bool(v) for v in values]
            elif np.issubdtype(values.dtype, np.floating):
                columns[name] = [None if math.isnan(v) else float(v) for v in values]
            else:
                columns[name] = [int(v) for v in values]

    return ComparisonValues(
        id=list(ids),
        similarity=[None if math.isnan(v) else float(v) for v in similarity],
        corresponds=[
            None if int(c) == int(NO_CORRESPONDENCE) else int(c) for c in corresponds
        ],
        exact=columns.pop("exact", []),
        columns=columns,
    )


@router.get(
    "/{pair_id}",
    response_model=ComparisonSummary,
    summary="A computed comparison's scalars and provenance",
)
def comparison_summary(
    pair_id: str = Path(examples=["vibrio-nj__vibrio-upgma"]),
    metric: str = Query("rf"),
    include_values: bool = Query(
        False,
        description=(
            "Include whole-tree per-node values for the left tree. One entry "
            "per node (35,291 for vibrio) — large, and slices are the intended "
            "way to read values. Off by default."
        ),
    ),
) -> ComparisonSummary:
    reader = pair_or_404(pair_id, metric)
    notes = reader.meta.notes
    reconciliation = notes.get("reconciliation", {})

    values = None
    if include_values:
        values = values_at(pair_id, "left", list(range(reader.meta.n_left)), reader)

    return ComparisonSummary(
        pair=reader.meta.pair_id,
        metric=reader.meta.metric,
        left=reader.meta.left,
        right=reader.meta.right,
        summary=reader.meta.summary,
        shared_leaves=reconciliation.get("shared_leaves", 0),
        dropped_from_left=reconciliation.get("dropped_from_left", []),
        dropped_from_right=reconciliation.get("dropped_from_right", []),
        same_species=reconciliation.get("same_species", True),
        caution=notes.get("caution"),
        values=values,
    )


@router.get(
    "/{pair_id}/slice",
    response_model=ComparisonSlice,
    summary="Comparison values aligned to a tree slice",
)
def comparison_slice(
    pair_id: str = Path(examples=["vibrio-nj__vibrio-upgma"]),
    tree: str = Query(description="Which tree of the pair to return values for."),
    root: int = Query(0, ge=0),
    budget: int = Query(500, ge=1, le=50_000),
    metric: str = Query("rf"),
    order: Order = Query("size", description=ORDER_DESCRIPTION),
) -> ComparisonSlice:
    """Values for exactly the nodes a tree slice with the same parameters returns.

    Summarisation is deterministic, so running it again here reproduces the same
    node set in the same order. ``nodes.id`` is returned as well, so a client can
    verify that rather than trust it -- and can join by id if it prefers.

    For a single round trip, pass ``?compare=`` to the tree slice endpoint
    instead; this endpoint exists for the case where the client already holds
    the topology and only wants to switch metric.
    """
    reader = pair_or_404(pair_id, metric)
    side = side_of(reader, tree)

    try:
        tree_reader = tree_registry.get_tree(tree)
    except tree_registry.TreeNotFound:
        raise errors.not_found(
            "tree_not_found", f"No tree {tree!r}.", "GET /api/datasets lists them."
        ) from None
    if root >= tree_reader.meta.n_nodes:
        raise errors.not_found(
            "node_out_of_range",
            f"Node {root} is outside {tree!r}, which has "
            f"{tree_reader.meta.n_nodes:,} nodes.",
        )

    node = summariser_for(tree_reader, tree, order, reader, metric).summarise(root, budget)
    ids = flatten(node)["id"]

    other = reader.meta.right if side == "left" else reader.meta.left
    return ComparisonSlice(
        pair=reader.meta.pair_id,
        metric=reader.meta.metric,
        tree=tree,
        other_tree=other,
        root=root,
        budget=budget,
        nodes=values_at(reader.meta.pair_id, side, ids, reader),
    )
