"""Engine and session handling.

SQLite by default, PostgreSQL by URL. The schema is deliberately plain — no
window functions, no JSON operators, no vendor types — which is what makes that
substitution safe rather than aspirational: the two engines genuinely agree on
this much SQL.

Why SQLite is a real answer and not a placeholder: the engines differ least in
SQL and most in **concurrency**. SQLite allows one writer at a time. That is
irrelevant for a single-process deployment and decisive for one with several
workers competing for jobs. So the choice tracks *writers*, not
*dev-versus-production* — and a single-user or desktop deployment can stay on
SQLite permanently without it being a compromise.

Keeping SQLite as the default also preserves something worth having: the whole
backend still runs from `uv sync` and a directory, with no service to install.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .. import config
from .models import Base

#: Engines are cached **by URL**, not globally. The database belongs to the
#: store it describes — ownership rows are meaningless against a different set
#: of stores — so pointing at another store must yield another database. Caching
#: a single engine made that impossible, and the symptom was quiet: ingesting
#: into a temporary store wrote its ownership rows into the real database, and
#: tests passed by reading ids that happened to match.
_engines: dict[str, tuple[Engine, sessionmaker[Session]]] = {}


def database_url() -> str:
    """Where the database lives, for the store currently configured.

    `PHYLODELTA_DATABASE_URL` overrides entirely — which is how a deployment
    points at PostgreSQL.
    """
    override = os.environ.get("PHYLODELTA_DATABASE_URL")
    if override:
        return override
    path = Path(config.STORE_DIR) / "phylodelta.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{path}"


def engine() -> Engine:
    url = database_url()
    cached = _engines.get(url)
    if cached is not None:
        return cached[0]
    connect_args = {}
    if url.startswith("sqlite"):
        # The API reads on a threadpool; SQLAlchemy's own pooling keeps a
        # connection per thread, so the check would reject a legitimate use.
        connect_args["check_same_thread"] = False

    made = create_engine(url, future=True, connect_args=connect_args)

    if url.startswith("sqlite"):

        @event.listens_for(made, "connect")
        def _sqlite_pragmas(connection, _record):  # pragma: no cover - trivial
            cursor = connection.cursor()
            # WAL lets readers proceed while a writer holds the lock, which is
            # the difference between "one writer" and "one user at a time".
            cursor.execute("PRAGMA journal_mode=WAL")
            # Wait rather than fail when a write collides; ingestion batches
            # can hold the lock for a moment.
            cursor.execute("PRAGMA busy_timeout=5000")
            # Foreign keys are off by default in SQLite, which silently makes
            # every ForeignKey in models.py decorative.
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    _engines[url] = (
        made,
        sessionmaker(bind=made, expire_on_commit=False, future=True),
    )
    return made


def create_schema() -> None:
    """Bring the database up to the current schema.

    Creates missing tables, then adds missing **columns** to tables that
    already exist. `create_all` alone does only the first: it skips any table
    that is present, whatever shape it is in. That was fine while every store
    was rebuildable, and stopped being fine when uploads started putting user
    data in there — the symptom was `no such column: comparisons.display_name`
    against a database holding trees somebody had uploaded.

    **This handles additive changes only**, which is what the schema has needed
    so far. A renamed, retyped or dropped column is refused loudly rather than
    guessed at, because guessing means silent data loss. When one is needed,
    that is the point to adopt a real migration tool (Alembic) rather than
    grow this function into one.
    """
    made = engine()
    Base.metadata.create_all(made)
    _add_missing_columns(made, Base.metadata)


def _add_missing_columns(made: Engine, metadata) -> None:
    """ALTER TABLE ... ADD COLUMN for anything the model has and the table does not.

    Takes its metadata rather than reaching for `Base.metadata`, so this can be
    exercised against a throwaway schema — a test that added a column to the
    real model to check the refusal path would leave it there for every test
    that followed.
    """
    from sqlalchemy import inspect, text
    from sqlalchemy.schema import CreateColumn

    inspector = inspect(made)
    existing_tables = set(inspector.get_table_names())

    for table in metadata.sorted_tables:
        if table.name not in existing_tables:
            continue
        present = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in present:
                continue
            if column.primary_key:
                # Cannot be added to a populated table in any engine, and a new
                # primary key is never an additive change anyway.
                raise RuntimeError(
                    f"{table.name}.{column.name} is a new primary key; this "
                    "needs a real migration, not an ADD COLUMN."
                )

            spec = CreateColumn(column).compile(made).string
            # A NOT NULL column needs something for the rows already there.
            # Taking it from the model's own default keeps the migrated value
            # and the value a fresh insert would get identical.
            if not column.nullable and "DEFAULT" not in spec.upper():
                fallback = getattr(column.default, "arg", None)
                if fallback is None:
                    raise RuntimeError(
                        f"{table.name}.{column.name} is NOT NULL with no default; "
                        "existing rows have no value for it. Give it a default "
                        "or make it nullable."
                    )
                literal = (
                    f"'{fallback}'" if isinstance(fallback, str) else repr(fallback)
                )
                spec = f"{spec} DEFAULT {literal}"

            with made.begin() as connection:
                connection.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {spec}"))


@contextmanager
def session() -> Iterator[Session]:
    """A transactional scope. Commits on success, rolls back on error."""
    engine()
    active = _engines[database_url()][1]()
    try:
        yield active
        active.commit()
    except Exception:
        active.rollback()
        raise
    finally:
        active.close()


@contextmanager
def using_store(store_dir) -> Iterator[None]:
    """Point the database at a particular store for the duration.

    The offline commands take a `store_dir` so tests can build into a temporary
    directory. Without this the stores would go there and the ownership rows
    would go to the configured store — two halves of one dataset in two places,
    which is how a test run ends up writing to a developer's real database.
    """
    original = config.STORE_DIR
    config.STORE_DIR = Path(store_dir)
    try:
        yield
    finally:
        config.STORE_DIR = original


def reset() -> None:
    """Dispose every cached engine. For tests that rebuild a store."""
    for made, _ in _engines.values():
        made.dispose()
    _engines.clear()
