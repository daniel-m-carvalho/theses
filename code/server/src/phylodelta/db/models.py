"""The relational half of the store.

What lives here and what does not
---------------------------------
Only what is **mutable, relational and concurrently written**: who owns which
dataset, when it arrived, what state it is in. The bulk — node columns,
correspondence, isolate tuples — stays in flat memory-mapped files, because the
access pattern there is a contiguous index range and that is a memcpy, not a
query (§18.3).

**Metadata is not duplicated here.** Leaf counts, depth, species and method stay
in each store's ``meta.json``, which remains authoritative and self-describing:
a store directory can be read without the database. This table holds ownership
and a pointer, and nothing a store already knows about itself. Two sources of
truth for the same fact is how they drift.

**Owner is a column, never a path segment.** `store_path` does not contain the
owner id. That is what keeps sharing — deferred, but not foreclosed — a new
table rather than a data migration (§19.6).
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _now() -> datetime:
    return datetime.now(UTC)


class DatasetKind(str, enum.Enum):
    TREE = "tree"
    ISOLATES = "isolates"


class DatasetStatus(str, enum.Enum):
    #: Uploaded and accepted, not yet ingested into a store.
    PENDING = "pending"
    #: Being parsed and written.
    INGESTING = "ingesting"
    #: A store exists and can be served.
    READY = "ready"
    #: Ingestion failed; `error` says why.
    FAILED = "failed"


class Dataset(Base):
    """A tree or an isolate table belonging to someone."""

    __tablename__ = "datasets"

    #: Opaque and unique. Not derived from the filename: two users uploading
    #: `vibrio-upgma-tree.nwk` must not collide, and a name is not an identity.
    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    #: Opaque subject id. Whether it comes from a PhyloViz token or a local
    #: account is decided behind `api.identity` and is not this table's concern
    #: (§19.5) — which is why there is no users table and no foreign key here.
    owner_id: Mapped[str] = mapped_column(String(128), index=True)

    kind: Mapped[DatasetKind] = mapped_column(Enum(DatasetKind))
    status: Mapped[DatasetStatus] = mapped_column(
        Enum(DatasetStatus), default=DatasetStatus.PENDING
    )

    #: What the user calls it. Not unique, not an identifier.
    display_name: Mapped[str] = mapped_column(String(255))
    #: The filename it arrived as, kept for provenance.
    source_name: Mapped[str] = mapped_column(String(255), default="")

    #: Where the store lives, relative to STORE_DIR. Owner-independent by
    #: design — see the module docstring.
    store_path: Mapped[str] = mapped_column(String(512), default="")

    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    comparisons_left: Mapped[list["Comparison"]] = relationship(
        back_populates="left", foreign_keys="Comparison.left_id"
    )

    __table_args__ = (
        # The query every read path makes: this owner's datasets of this kind.
        Index("ix_datasets_owner_kind", "owner_id", "kind"),
    )


class ComparisonStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    READY = "ready"
    FAILED = "failed"


class Comparison(Base):
    """A computed comparison between two of an owner's trees.

    Given a status because computing one is seconds to minutes and cannot
    happen inside a request (§19.6). The row exists from the moment it is asked
    for, so a client has something to poll.
    """

    __tablename__ = "comparisons"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)

    #: What the user calls this comparison. Held here rather than read from
    #: either dataset: the user names the comparison, and reaching through a
    #: relationship to answer a status poll would be a second query — and a
    #: lazy load on a detached row.
    display_name: Mapped[str] = mapped_column(String(255), default="")

    left_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"))
    right_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"))

    status: Mapped[ComparisonStatus] = mapped_column(
        Enum(ComparisonStatus), default=ComparisonStatus.PENDING
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    store_path: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    left: Mapped[Dataset] = relationship(
        foreign_keys=[left_id], back_populates="comparisons_left"
    )
    right: Mapped[Dataset] = relationship(foreign_keys=[right_id])

    __table_args__ = (
        Index("ix_comparisons_owner", "owner_id", "status"),
        Index("ix_comparisons_pair", "left_id", "right_id"),
    )
