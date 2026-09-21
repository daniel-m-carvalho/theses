"""Where things live.

Both directories are overridable by environment variable so the service can be
deployed with the store somewhere other than the repository, and so tests can
point at a fixture store without touching the real one.
"""

from __future__ import annotations

import os
from pathlib import Path

# .../code/server/src/phylocmp/config.py -> .../repo/theses
_REPO_ROOT = Path(__file__).resolve().parents[3].parent


def _dir_from_env(var: str, default: Path) -> Path:
    raw = os.environ.get(var)
    return Path(raw).expanduser().resolve() if raw else default


#: Read-only source data: the Newick trees and the isolate TSVs.
DATASETS_DIR = _dir_from_env("PHYLOCMP_DATASETS", _REPO_ROOT / "datasets")

#: Generated artefacts. Rebuildable from DATASETS_DIR, so it is gitignored.
STORE_DIR = _dir_from_env("PHYLOCMP_STORE", Path(__file__).resolve().parents[2] / "store")

TREES_DIR = STORE_DIR / "trees"
PAIRS_DIR = STORE_DIR / "pairs"
ISOLATES_DIR = STORE_DIR / "isolates"

#: Scratch space for work that is not an artefact: trees materialised as Newick
#: for a subprocess metric to read, and anything else with a lifetime shorter
#: than a run.
#:
#: Inside STORE_DIR rather than the system temp directory, deliberately. These
#: files can be hundreds of KB per tree and are written per pair; keeping them
#: beside the store they derive from means one directory to point at a large
#: disk, one to clean, and no surprise when a container's /tmp turns out to be
#: a small tmpfs. It is safe to delete at any time.
SCRATCH_DIR = STORE_DIR / "scratch"

#: Where built native helpers live — the conformance oracle, and any metric that
#: is a binary rather than a Python function. Sources and build scripts are in
#: the repository; what they produce is not, so this is gitignored and
#: rebuildable (see native/build_treediff.sh).
NATIVE_DIR = _dir_from_env(
    "PHYLOCMP_NATIVE", Path(__file__).resolve().parents[2] / "native"
)
