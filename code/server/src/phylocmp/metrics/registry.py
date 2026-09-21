"""Discover metric plugins.

Adding a metric is adding a directory, not editing code -- which is the point:
which comparisons this backend should offer beyond RF is still open, and the
registry is how that stays open.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

from typing import TYPE_CHECKING

from .contract import MetricManifest

if TYPE_CHECKING:
    from .runners import Runner

PLUGINS_DIR = Path(__file__).parent / "plugins"


class MetricNotFound(KeyError):
    pass


def discover(plugins_dir: Path | None = None) -> dict[str, MetricManifest]:
    root = Path(plugins_dir or PLUGINS_DIR)
    found: dict[str, MetricManifest] = {}
    if not root.is_dir():
        return found
    for manifest_path in sorted(root.glob("*/metric.json")):
        manifest = MetricManifest.from_json(
            json.loads(manifest_path.read_text()), directory=manifest_path.parent
        )
        if manifest.name in found:
            raise ValueError(f"two plugins both declare the metric name {manifest.name!r}")
        found[manifest.name] = manifest
    return found


def load(name: str, plugins_dir: Path | None = None) -> "Runner":
    """Return a callable for ``name``, whatever language it is written in."""
    from .runners import make_runner

    manifest = discover(plugins_dir).get(name)
    if manifest is None:
        raise MetricNotFound(name)
    return make_runner(manifest)
