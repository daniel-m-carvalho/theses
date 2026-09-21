"""Discovery endpoints: what this server has, and whether it is ready."""

from __future__ import annotations

import itertools
import json

from fastapi import APIRouter

from .. import config
from ..trees import registry
from ..metrics import registry as metric_registry
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

router = APIRouter(prefix="/api", tags=["meta"])

API_VERSION = "0.1.0"


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


def _isolates() -> list[IsolateSummary]:
    root = config.ISOLATES_DIR
    if not root.is_dir():
        return []
    out: list[IsolateSummary] = []
    for directory in sorted(root.iterdir()):
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


@router.get("/datasets", response_model=DatasetsResponse, summary="Trees, pairs and isolate stores")
def datasets() -> DatasetsResponse:
    trees = [
        TreeSummary(
            id=reader.meta.id,
            species=reader.meta.species,
            method=reader.meta.method,
            n_nodes=reader.meta.n_nodes,
            n_leaves=reader.meta.n_leaves,
            max_depth=reader.meta.max_depth,
        )
        for reader in (registry.get_tree(tid) for tid in registry.available_tree_ids())
    ]
    return DatasetsResponse(trees=trees, pairs=_pairs(trees), isolates=_isolates())


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
