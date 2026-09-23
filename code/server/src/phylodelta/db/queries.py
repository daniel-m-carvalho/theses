"""The handful of questions the API and the pipeline ask of the database."""

from __future__ import annotations

from sqlalchemy import select

from .models import Dataset, DatasetKind, DatasetStatus
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
