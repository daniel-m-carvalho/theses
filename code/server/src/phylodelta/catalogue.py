"""What source data exists, and what it is called.

Tree ids are derived from the dataset filenames rather than configured by hand:
``vibrio-upgma-tree.nwk`` -> id ``vibrio-upgma``, species ``vibrio``, method
``upgma``. The species half of that is load-bearing, not cosmetic — see
``isolates``: ST identifiers are unique only *within* a species, so ST 11 in
vibrio and ST 11 in clostridium are different organisms. Species is therefore
part of every isolate lookup key, and the tree carries it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from . import config

#: Tree-building methods this backend serves. goeBURST files are excluded by
#: decision, not by oversight: they are minimum-spanning forests, multi-root and
#: with data on internal nodes, which neither the RF bipartition model nor the
#: rooted-slicing model applies to. Out of scope for the thesis.
SUPPORTED_METHODS = ("upgma", "nj")

_FILENAME = re.compile(r"^(?P<species>[a-z0-9]+(?:-[a-z0-9]+)*?)-(?P<method>[a-z]+)-tree\.nwk$")


@dataclass(frozen=True, slots=True)
class TreeSource:
    id: str
    species: str
    method: str
    path: Path


def discover_tree_sources(datasets_dir: Path | None = None) -> list[TreeSource]:
    """Every supported Newick file under ``datasets/gen_trees``."""
    root = Path(datasets_dir or config.DATASETS_DIR) / "gen_trees"
    if not root.is_dir():
        return []

    found: list[TreeSource] = []
    for path in sorted(root.glob("*.nwk")):
        match = _FILENAME.match(path.name)
        if not match:
            continue
        species = match.group("species")
        method = match.group("method")
        if method not in SUPPORTED_METHODS:
            continue
        found.append(
            TreeSource(id=f"{species}-{method}", species=species, method=method, path=path)
        )
    return found


def discover_isolate_sources(datasets_dir: Path | None = None) -> dict[str, Path]:
    """species -> isolate TSV."""
    root = Path(datasets_dir or config.DATASETS_DIR) / "isolated_data"
    if not root.is_dir():
        return {}
    return {path.stem: path for path in sorted(root.glob("*.tsv"))}
