"""The handful of questions the API and the pipeline ask of the database."""

from __future__ import annotations

from sqlalchemy import select

from .models import (
    Comparison,
    ComparisonStatus,
    Dataset,
    DatasetKind,
    DatasetStatus,
)
from .session import session


def register_dataset(
    dataset_id: str,
    owner_id: str,
    kind: DatasetKind,
    display_name: str,
    store_path: str,
    source_name: str = "",
) -> None:
    """Record a dataset, or update it if it is already there.

    Idempotent because ingestion is: `build-all` can be re-run over the same
    sources and must not accumulate duplicates or fail on the second pass.
    """
    with session() as active:
        existing = active.get(Dataset, dataset_id)
        if existing is None:
            active.add(
                Dataset(
                    id=dataset_id, owner_id=owner_id, kind=kind,
                    display_name=display_name, store_path=store_path,
                    source_name=source_name, status=DatasetStatus.READY,
                )
            )
            return
        existing.owner_id = owner_id
        existing.display_name = display_name
        existing.store_path = store_path
        existing.source_name = source_name
        existing.status = DatasetStatus.READY
        existing.error = None


def datasets_for(owner_id: str, kind: DatasetKind | None = None) -> list[Dataset]:
    """An owner's datasets. The query every read path begins with."""
    statement = select(Dataset).where(
        Dataset.owner_id == owner_id, Dataset.status == DatasetStatus.READY
    )
    if kind is not None:
        statement = statement.where(Dataset.kind == kind)
    with session() as active:
        return list(active.scalars(statement.order_by(Dataset.id)))


def dataset_for(owner_id: str, dataset_id: str) -> Dataset | None:
    """One dataset, **only if this owner has it**.

    Returning None for "not yours" as well as "does not exist" is deliberate:
    the two are indistinguishable to a caller, so an id cannot be probed for
    existence by someone who does not own it.
    """
    with session() as active:
        found = active.get(Dataset, dataset_id)
        if found is None or found.owner_id != owner_id:
            return None
        if found.status != DatasetStatus.READY:
            return None
        return found


def owns_all(owner_id: str, dataset_ids: list[str]) -> bool:
    return all(dataset_for(owner_id, i) is not None for i in dataset_ids)


def record_upload(
    comparison_id: str,
    left_id: str,
    right_id: str,
    owner_id: str,
    display_name: str,
    left_source: str,
    right_source: str,
    store_path: str,
) -> None:
    """Record an accepted bundle: two pending trees and a pending comparison.

    One transaction, because a comparison referring to a dataset that is not
    there is not a state the rest of the system knows how to read — and the
    foreign keys would refuse it anyway. Either the bundle is visible whole or
    the upload failed and the files are discarded.

    The datasets are `pending`, not `ready`: nothing has been parsed yet, and
    `dataset_for` serves only `ready` rows, so an uploaded tree is not
    reachable through any read endpoint until a job has actually built its
    store. That is the property that keeps a half-ingested upload from being
    served as though it were complete.
    """
    with session() as active:
        for dataset_id, source in ((left_id, left_source), (right_id, right_source)):
            active.add(
                Dataset(
                    id=dataset_id,
                    owner_id=owner_id,
                    kind=DatasetKind.TREE,
                    status=DatasetStatus.PENDING,
                    display_name=display_name,
                    source_name=source,
                    store_path="",
                )
            )
        # Before the comparison, which points at both.
        active.flush()
        active.add(
            Comparison(
                id=comparison_id,
                owner_id=owner_id,
                left_id=left_id,
                right_id=right_id,
                display_name=display_name,
                status=ComparisonStatus.PENDING,
                store_path=store_path,
            )
        )


def comparison_for(owner_id: str, comparison_id: str) -> Comparison | None:
    """One comparison record, **only if this owner has it**.

    Unlike `dataset_for` this returns rows in every status, because status is
    the whole point: a client polls this to find out whether its upload is
    still pending, has failed, or is ready to read.
    """
    with session() as active:
        found = active.get(Comparison, comparison_id)
        if found is None or found.owner_id != owner_id:
            return None
        return found


def comparisons_for(owner_id: str) -> list[Comparison]:
    """An owner's comparisons, newest first."""
    with session() as active:
        return list(
            active.scalars(
                select(Comparison)
                .where(Comparison.owner_id == owner_id)
                .order_by(Comparison.created_at.desc(), Comparison.id)
            )
        )
