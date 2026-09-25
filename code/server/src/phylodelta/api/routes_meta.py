"""Discovery endpoints: what this server has, and whether it is ready."""

from __future__ import annotations

import itertools
import json

from fastapi import APIRouter, Depends

from .. import config
from ..trees import registry
from .identity import current_owner, current_principal
from ..metrics import registry as metric_registry
from .. import db
from ..db import jobs as queue
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
    WhoAmI,
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
    """Liveness, plus whether anything is draining the queue.

    `queue` is here because the failure an operator actually hits is not the
    API being down — it answers fine — but no worker running, which looks
    identical to a user except that nothing ever leaves `pending`. A rising
    pending count with nothing running is that, visible.
    """
    tree_ids = registry.available_tree_ids()
    try:
        depth = queue.queue_depth()
    except Exception:
        # Health must not fail because the database is unreachable; that is
        # itself worth reporting, and reporting it needs this to answer.
        depth = {}
    return HealthResponse(
        status="ok",
        version=API_VERSION,
        store_ready=bool(tree_ids),
        queue=depth,
    )


@router.get(
    "/me",
    response_model=WhoAmI,
    tags=["meta"],
    summary="The caller, as this server resolved them",
)
def who_am_i(principal=Depends(current_principal)) -> WhoAmI:
    """Who this request is for.

    The one endpoint that reports on authentication rather than consuming it.
    Note what it does *not* do: no route decides anything from these fields —
    ownership is enforced by `owner_id` in the database, and this is for the
    client's benefit only.
    """
    return WhoAmI(
        owner_id=principal.owner_id,
        subject=principal.subject,
        issuer=principal.issuer,
        email=principal.email,
        display_name=principal.display_name,
        mock=principal.mock,
    )


def _pairs(owner: str, trees: list[TreeSummary]) -> list[PairSummary]:
    """The comparisons this owner actually has.

    **Read from the database, not derived from the trees.** This used to
    enumerate every combination of an owner's trees and offer each as an
    available pair. That was right when the catalogue was the only source —
    every combination really had been computed — and became wrong the moment a
    comparison was something a user creates:

    * it emitted `sorted(a, b)` as the id, while an uploaded pair is stored
      under the order it was uploaded in, so a client following the listed id
      got a 404;
    * it advertised comparisons nobody had asked for and nothing had computed;
    * it was quadratic in the owner's trees, and loaded every tree's full label
      set on every request to decide overlap.

    Now a pair is listed because a row says it exists. The evidence — shared
    leaves, the species caution — is read back from what the computation
    actually recorded rather than re-derived, so the listing cannot disagree
    with the result.
    """
    known = {tree.id: tree for tree in trees}
    out: list[PairSummary] = []

    for record in db.comparisons_for(owner):
        left, right = record.left_id, record.right_id
        status = record.status.value
        summary = PairSummary(
            id=record.id, display_name=record.display_name, left=left, right=right,
            species="", same_species=None, status=status, metrics=[],
        )

        left_tree, right_tree = known.get(left), known.get(right)
        if left_tree and right_tree:
            left_species, right_species = left_tree.species, right_tree.species
            declared = bool(left_species and right_species)
            summary.same_species = (
                left_species == right_species if declared else None
            )
            summary.species = (
                left_species
                if summary.same_species
                else "/".join(p for p in (left_species, right_species) if p)
            )

        # Only a computed pair has a correspondence to report from.
        if status == "ready" and registry_pairs.has_correspondence(record.id):
            notes = registry_pairs.get_correspondence(record.id).meta.notes
            reconciliation = notes.get("reconciliation", {})
            summary.shared_leaves = reconciliation.get("shared_leaves", 0)
            summary.label_match = reconciliation.get("label_match", "identity")
            summary.caution = notes.get("caution")
            if left_tree and right_tree:
                smaller = max(1, min(left_tree.n_leaves, right_tree.n_leaves))
                summary.shared_fraction = round(summary.shared_leaves / smaller, 4)
            summary.metrics = registry_pairs.available(record.id)

        out.append(summary)
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
                display_name=record.display_name,
                species=reader.meta.species,
                method=reader.meta.method,
                n_nodes=reader.meta.n_nodes,
                n_leaves=reader.meta.n_leaves,
                max_depth=reader.meta.max_depth,
            )
        )
    return DatasetsResponse(
        trees=trees, pairs=_pairs(owner, trees), isolates=_isolates(owner)
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
