from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DATASETS = REPO_ROOT / "datasets"


@pytest.fixture(scope="session")
def datasets_dir() -> Path:
    if not DATASETS.is_dir():
        pytest.skip(f"datasets not present at {DATASETS}")
    return DATASETS


@pytest.fixture(scope="session")
def real_store(tmp_path_factory, datasets_dir: Path) -> Path:
    """Ingest the real trees once into a throwaway store.

    Built from the datasets rather than from a committed fixture so the tests
    exercise the same path the precompute CLI takes, and so a parser change
    cannot pass against a stale fixture.
    """
    from phylocmp.precompute.pipeline import ingest_trees

    store = tmp_path_factory.mktemp("store")
    assert ingest_trees(datasets_dir=datasets_dir, store_dir=store) == 0
    return store
