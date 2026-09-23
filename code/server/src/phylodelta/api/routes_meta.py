"""Discovery endpoints: what this server has, and whether it is ready."""

from __future__ import annotations

import itertools
import json

from fastapi import APIRouter, Depends

from .. import config
from ..trees import registry
from .identity import current_owner
from ..metrics import registry as metric_registry
from .. import db
from ..metrics import registry_pairs
from ..metrics.runners import is_available
from .schemas import (
    ColumnDescription,
    DatasetsResponse,
    HealthResponse,
    IsolateSummary,
    MetricOutputsDescription,
    MetricSummary,
    PairSummary,
    ScalarDescription,
    TreeSummary,
)

#: The API's own version, independent of any store's FORMAT_VERSION.
API_VERSION = "1.0.0"

#: Every route lives under this. The version is in the path rather than a
#: header because an integrator will be reading logs and running curl, and a
#: path segment lets /v1 and /v2 run side by side through a migration.
API_PREFIX = "/api/v1"

router = APIRouter(prefix=API_PREFIX, tags=["meta"])


@router.get("/health", response_model=HealthResponse, summary="Liveness and store readiness")
def health() -> HealthResponse:
    tree_ids = registry.available_tree_ids()
    return HealthResponse(status="ok", version=API_VERSION, store_ready=bool(tree_ids))


def _pairs(trees: list[TreeSummary]) -> list[PairSummary]:
    """Every pair of trees that shares at least one leaf label.

    Comparability is decided by **measured label overlap**, not by a rule about
    species. Two trees with no shared label cannot be compared by any
    clade-based metric -- there is no correspondence between their leaves for a
    clade to be preserved across -- so those pairs are omitted. Everything else
    is offered, with the evidence attached.

    Sequence types are numbered per species, so a vibrio and a clostridium tree
    overlap on ~99% of labels while sharing no actual organism. That is reported
    as a caution rather than used to block the pair: whether a cross-species
    comparison is worth making is the biologist's call, not this server's. What
    the server owes them is a clear statement of what was matched and how.
    """
    out: list[PairSummary] = []
    for left, right in itertools.combinations(sorted(trees, key=lambda t: t.id), 2):
        left_labels = registry.leaf_label_set(left.id)
        right_labels = registry.leaf_label_set(right.id)
        shared = len(left_labels & right_labels)
        if shared == 0:
            continue

        same_species = left.species == right.species
        fraction = shared / max(1, min(len(left_labels), len(right_labels)))
        caution = None
        if not same_species:
            caution = (
                f"{left.species} and {right.species} are different species. "
                "Sequence types are numbered per species, so leaves matched here "
                "by identical labels are not the same organisms. Interpret any "
                "distance accordingly."
            )

        pair_id = f"{left.id}__{right.id}"
        # Via the registry, which knows that a pair's shared correspondence is
        # not one of its metrics — it sits in a sibling directory.
        metrics = registry_pairs.available(pair_id)
        out.append(
            PairSummary(
                id=pair_id,
                left=left.id,
                right=right.id,
                species=left.species if same_species else f"{left.species}/{right.species}",
                same_species=same_species,
                label_match="identity",
                shared_leaves=shared,
                shared_fraction=round(fraction, 4),
                caution=caution,
                metrics=metrics,
            )
        )
    return out


def _isolates(owner: str) -> list[IsolateSummary]:
    out: list[IsolateSummary] = []
    for record in db.datasets_for(owner, kind=db.DatasetKind.ISOLATES):
        directory = config.STORE_DIR / record.store_path
        meta_path = directory / "meta.json"
        if not meta_path.exists():
            continue
        raw = json.loads(meta_path.read_text())
        out.append(
            IsolateSummary(
                species=raw.get("species", directory.name),
                n_rows=raw.get("n_rows", 0),
                keys=[f["name"] for f in raw.get("facets", [])],
            )
        )
    return out


@router.get(
    "/datasets",
    response_model=DatasetsResponse,
    summary="The trees, pairs and isolate stores belonging to you",
)
def datasets(owner: str = Depends(current_owner)) -> DatasetsResponse:
    """What this owner has.

    Answered from the database rather than by walking the store. That is what
    makes it filterable by owner at all — and it removes a scan whose cost grew
    with the number of datasets, since pairs are quadratic in trees and each
    needed both trees' labels decoded.

    Structural facts (leaf counts, depth, species) still come from each store's
    own `meta.json`, which stays authoritative. The database holds ownership
    and a pointer, not a second copy of what a store knows about itself.
    """
    owned = db.datasets_for(owner, kind=db.DatasetKind.TREE)
    trees = []
    for record in owned:
        try:
            reader = registry.get_tree(record.id)
        except registry.TreeNotFound:
            # Recorded but its store is missing — a partial ingest, or a store
            # wiped without the database. Skip rather than fail the listing;
            # the row's status is the place to represent that, not an error
            # that hides every other dataset.
            continue
        trees.append(
            TreeSummary(
                id=reader.meta.id,
                species=reader.meta.species,
                method=reader.meta.method,
                n_nodes=reader.meta.n_nodes,
                n_leaves=reader.meta.n_leaves,
                max_depth=reader.meta.max_depth,
            )
        )
    return DatasetsResponse(
        trees=trees, pairs=_pairs(trees), isolates=_isolates(owner)
    )


@router.get(
    "/metrics",
    response_model=list[MetricSummary],
    summary="Comparison metrics this server can compute",
)
def metrics() -> list[MetricSummary]:
    return [
        MetricSummary(
            name=manifest.name,
            title=manifest.title,
            description=manifest.description,
            kind=manifest.kind,
            available=is_available(manifest),
            version=manifest.version,
            capabilities=manifest.capabilities,
            outputs=MetricOutputsDescription(
                summary=[
                    ScalarDescription(
                        key=s.key, label=s.label, description=s.description
                    )
                    for s in manifest.outputs.scalars
                ],
                columns=[
                    ColumnDescription(
                        name=c.name, dtype=c.dtype, semantics=c.semantics,
                        label=c.label, description=c.description, render=c.render,
                    )
                    for c in manifest.outputs.columns
                ],
            ),
        )
        for manifest in metric_registry.discover().values()
    ]
