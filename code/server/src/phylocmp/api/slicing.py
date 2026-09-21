"""Shared slicing setup for the tree and comparison endpoints.

Both endpoints must produce **the same node set in the same order** for the same
parameters, or the values a client fetches separately will not line up with the
topology it is drawing. Keeping the construction in one place is how that stays
true, rather than by two call sites agreeing forever.
"""

from __future__ import annotations

from typing import Literal

import numpy as np

from ..metrics import registry_pairs
from ..metrics.store import CorrespondenceReader, PairReader
from ..trees.store import TreeReader
from . import errors
from ..trees.summarise import Summariser

Order = Literal["size", "difference"]

ORDER_DESCRIPTION = (
    "Where the budget spends its detail. `size` expands the largest clades "
    "first — the overview. `difference` expands the clades containing the most "
    "disagreement first, so the user lands on the changes; it requires a "
    "comparison, since the ordering is computed from its values."
)


def side_of(reader, tree_id: str) -> str:
    """Which side of the pair a tree is. Works for either reader kind."""
    if tree_id == reader.meta.left:
        return "left"
    if tree_id == reader.meta.right:
        return "right"
    raise errors.bad_request(
        "tree_not_in_pair",
        f"Tree {tree_id!r} is not part of pair {reader.meta.pair_id!r}.",
        f"This pair compares {reader.meta.left!r} and {reader.meta.right!r}.",
    )


def correspondence_or_404(pair_id: str) -> CorrespondenceReader:
    """A pair's shared correspondence: the gradient, and what links the panels."""
    try:
        return registry_pairs.get_correspondence(pair_id)
    except registry_pairs.CorrespondenceNotFound:
        raise errors.not_found(
            "comparison_not_computed",
            f"No computed comparison for pair {pair_id!r}.",
            f"Run `phylocmp compute-pairs --only {pair_id}`, "
            "or see GET /api/datasets for pairs that are ready.",
        ) from None


def pair_or_404(pair_id: str, metric: str) -> PairReader:
    try:
        return registry_pairs.get_pair(pair_id, metric)
    except registry_pairs.PairNotFound:
        computed = registry_pairs.available(pair_id)
        if computed:
            raise errors.not_found(
                "metric_not_computed",
                f"No metric {metric!r} for pair {pair_id!r}.",
                f"Computed for this pair: {', '.join(computed)}.",
            ) from None
        raise errors.not_found(
            "comparison_not_computed",
            f"No computed comparison for pair {pair_id!r}.",
            f"Run `phylocmp compute-pairs --only {pair_id}`, "
            "or see GET /api/datasets for pairs that are ready.",
        ) from None


def summariser_for(
    tree_reader: TreeReader,
    tree_id: str,
    order: Order,
    pair: PairReader | None,
    metric: str,
) -> Summariser:
    """A summariser with the priority the requested order implies."""
    if order == "size":
        return Summariser(tree_reader)

    if pair is None:
        raise errors.bad_request(
            "order_needs_comparison",
            "order=difference ranks clades by how much disagreement they "
            "contain, so it needs a comparison.",
            "Pass compare=<pair>, or use GET /api/comparisons/{pair}/slice.",
        )
    # Ranked from correspondence, which is shared, so this works whatever
    # metric was asked for — including one with no per-node columns.
    priority = registry_pairs.divergence_priority_for(
        pair.meta.pair_id, side_of(pair, tree_id), np.asarray(tree_reader.parent)
    )
    return Summariser(tree_reader, priority=priority)
