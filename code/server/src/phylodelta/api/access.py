"""Ownership checks, in one place.

Every read path begins with the same question — *is this yours?* — and the
answer has to be shaped carefully:

**"Not yours" and "does not exist" return the same 404.** Distinguishing them
would let anyone discover which ids exist by probing, which is a disclosure
even when the data behind them stays unreachable. The message names what was
asked for, not whether it is real.

**Ownership is checked before the store is touched.** A reader opens memory
maps and decodes labels; doing that for a dataset the caller cannot have is
both wasted work and a way to distinguish the two cases by timing.
"""

from __future__ import annotations

from .. import db
from . import errors
from ..metrics import registry_pairs
from ..trees import registry as tree_registry


def tree_or_404(owner: str, tree_id: str):
    """A tree reader, if this owner has that tree."""
    if db.dataset_for(owner, tree_id) is None:
        raise errors.not_found(
            "tree_not_found",
            f"No tree {tree_id!r}.",
            "GET /api/v1/datasets lists the trees you have.",
        )
    try:
        return tree_registry.get_tree(tree_id)
    except tree_registry.TreeNotFound:
        # Recorded as owned but its store is missing — a partial ingest, or a
        # store removed behind the database's back.
        raise errors.not_found(
            "tree_unavailable",
            f"Tree {tree_id!r} is recorded but its data is missing.",
            "It may still be ingesting, or ingestion may have failed.",
        ) from None


def isolates_or_404(owner: str, species: str):
    """An isolate reader, if this owner has that isolate set."""
    # Isolate stores are registered under a derived id; the species is what a
    # caller names, so the lookup goes through the same ownership check.
    if db.dataset_for(owner, f"isolates-{species}") is None:
        raise errors.not_found(
            "isolates_not_found",
            f"No isolate data for {species!r}.",
            "GET /api/v1/datasets lists what you have.",
        )
    from ..isolates import registry as isolate_registry

    try:
        return isolate_registry.get_isolates(species)
    except isolate_registry.IsolatesNotFound:
        raise errors.not_found(
            "isolates_unavailable",
            f"Isolate data for {species!r} is recorded but missing.",
        ) from None


def pair_or_404(owner: str, pair_id: str, metric: str):
    """A computed comparison, if this owner has both of its trees.

    A pair id names two datasets, so owning the comparison means owning both —
    checked rather than inferred from the pair's own record, so a comparison
    cannot outlive access to the trees it was computed from.
    """
    left, _, right = pair_id.partition("__")
    if not right or not db.owns_all(owner, [left, right]):
        raise errors.not_found(
            "comparison_not_found",
            f"No comparison {pair_id!r}.",
            "GET /api/v1/datasets lists the pairs available to you.",
        )
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
            f"Run `phylodelta compute-pairs --only {pair_id}`, "
            "or see GET /api/v1/datasets for pairs that are ready.",
        ) from None


def correspondence_or_404(owner: str, pair_id: str):
    """A pair's shared correspondence, if this owner has both of its trees."""
    left, _, right = pair_id.partition("__")
    if not right or not db.owns_all(owner, [left, right]):
        raise errors.not_found(
            "comparison_not_found",
            f"No comparison {pair_id!r}.",
            "GET /api/v1/datasets lists the pairs available to you.",
        )
    try:
        return registry_pairs.get_correspondence(pair_id)
    except registry_pairs.CorrespondenceNotFound:
        raise errors.not_found(
            "comparison_not_computed",
            f"No computed comparison for pair {pair_id!r}.",
            f"Run `phylodelta compute-pairs --only {pair_id}`.",
        ) from None
