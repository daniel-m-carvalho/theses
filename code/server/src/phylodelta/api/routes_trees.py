"""Tree metadata and slicing.

The slice endpoint is where the thesis claim is actually cashed out: the client
asks for a subtree at a leaf budget it can afford to draw, and receives only
that. Nodes it would have discarded after downloading are never sent.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query

from ..trees import registry
from ..trees.summarise import count_leaves, flatten
from .routes_comparisons import values_at
from . import errors
from .access import tree_or_404
from .identity import current_owner
from .routes_meta import API_PREFIX
from .schemas import SliceNodes, TreeDetail, TreeSlice
from .access import pair_or_404 as access_pair
from .slicing import ORDER_DESCRIPTION, Order, side_of, summariser_for

router = APIRouter(prefix=f"{API_PREFIX}/trees", tags=["trees"])

#: Guard-rail, not a recommendation. A browser drawing more tips than this is
#: already past the point the slicing exists to avoid; the cap stops one request
#: from materialising an entire 500k-leaf tree.
MAX_BUDGET = 50_000


def _reader(tree_id: str):
    try:
        return registry.get_tree(tree_id)
    except registry.TreeNotFound:
        raise errors.not_found(
            "tree_not_found",
            f"No tree {tree_id!r}.",
            "GET /api/datasets lists the ingested trees.",
        ) from None


@router.get("/{tree_id}", response_model=TreeDetail, summary="One tree's header")
def tree_detail(
    tree_id: str = Path(examples=["vibrio-upgma"]),
    owner: str = Depends(current_owner),
) -> TreeDetail:
    meta = tree_or_404(owner, tree_id).meta
    return TreeDetail(
        id=meta.id, species=meta.species, method=meta.method,
        n_nodes=meta.n_nodes, n_leaves=meta.n_leaves, max_depth=meta.max_depth,
        source=meta.source, suppressed_unary=meta.suppressed_unary, created=meta.created,
    )


@router.get(
    "/{tree_id}/slice",
    response_model=TreeSlice,
    summary="A subtree summarised to a leaf budget",
)
def tree_slice(
    tree_id: str = Path(examples=["vibrio-upgma"]),
    root: int = Query(0, ge=0, description="Stored node id to root the slice at."),
    budget: int = Query(
        500, ge=1, le=MAX_BUDGET, description="Maximum tips to return."
    ),
    compare: str | None = Query(
        None,
        description=(
            "A pair id. Returns this tree's comparison values alongside the "
            "topology, aligned index for index, in one round trip."
        ),
        examples=["vibrio-nj__vibrio-upgma"],
    ),
    metric: str = Query("rf", description="Only meaningful with `compare`."),
    order: Order = Query("size", description=ORDER_DESCRIPTION),
    owner: str = Depends(current_owner),
) -> TreeSlice:
    reader = tree_or_404(owner, tree_id)
    if root >= reader.meta.n_nodes:
        raise errors.not_found(
            "node_out_of_range",
            f"Node {root} is outside {tree_id!r}, which has "
            f"{reader.meta.n_nodes:,} nodes (0..{reader.meta.n_nodes - 1}).",
            "Node ids come from a slice's nodes.id, not from the source file.",
        )

    pair = access_pair(owner, compare, metric) if compare is not None else None
    node = summariser_for(reader, tree_id, order, pair, metric).summarise(root, budget)
    if node is None:  # unreachable while budget >= 1, but do not serve a lie
        raise errors.ApiError(
            500, "empty_slice", "Summarisation produced nothing."
        )

    flat = flatten(node)
    displayed = count_leaves(node)

    comparison = None
    if pair is not None:
        # Built from the same `flat["id"]` this response carries, so the two are
        # aligned by construction rather than by re-running anything.
        comparison = values_at(
            owner, pair.meta.pair_id, side_of(pair, tree_id), flat["id"], pair
        )

    hidden = sum(
        count for count, cut in zip(flat["true_leaf_count"], flat["truncated"]) if cut
    )
    return TreeSlice(
        tree=tree_id,
        root=root,
        budget=budget,
        displayed_leaves=displayed,
        hidden_leaves=hidden,
        total_leaves=int(reader.leaf_count[root]),
        nodes=SliceNodes(**flat),
        comparison=comparison,
    )
