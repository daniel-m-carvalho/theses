"""What a comparison metric is, independently of the language it is written in.

The requirement is that metrics be pluggable and addable in *any* language, so
the contract is defined in terms of data, not Python types. A metric is a
directory containing a ``metric.json`` manifest and an implementation; the
manifest says how to invoke it.

Two invocation kinds are defined:

``python``
    Imported in-process. The fast path, used by the built-in metrics.

``subprocess``
    Executed as a child process; trees in, results out. Slower per call, but it
    is paid once offline, and it is what makes "any language" true rather than
    aspirational — a C++ binary or an R script satisfies it with no Python at
    all.

A metric declares what it produces; it is not forced into a shape
--------------------------------------------------------------
**Clade correspondence is not part of a metric** (``trees.correspondence``).
``similarity`` and ``corresponds`` are computed once per pair and shared, so a
metric never reimplements the best-match search and never has to pretend to
produce one.

What a metric returns is therefore whatever it actually knows:

* **summary scalars**, free-form — one number, or several. A quartet tool
  reporting resolved and unresolved counts puts both here.
* **per-node columns**, named, and **optional**. RF contributes ``exact``.
  A geodesic distance contributes none, and is still perfectly usable: the
  client colours from correspondence and shows the number.

The earlier contract demanded ``similarity``/``corresponds``/``exact`` from
every metric, which meant a scalar-only metric could not be stored at all, and a
metric with *more* to say — the split sequence along a geodesic path, say — had
nowhere to put it. Both failures came from letting one metric's shape become
everyone's.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from ..trees.correspondence import NO_CORRESPONDENCE, Correspondence
from ..trees.newick import TreeArrays

__all__ = [
    "NO_CORRESPONDENCE",
    "ColumnSpec",
    "Metric",
    "MetricManifest",
    "MetricOutputs",
    "MetricResult",
    "MetricSide",
    "ScalarSpec",
    "validate_result",
]


#: How a client should read a column's values. The frontend needs this to render
#: a column it has never seen: a ratio can drive a colour ramp, a boolean can
#: only filter or overlay, and an index is a node id to follow.
SEMANTICS = ("boolean", "ratio", "count", "index", "number")

#: What a client might reasonably do with it. A hint, not an instruction — the
#: server states no colours (§9.2).
RENDER_HINTS = ("gradient", "overlay", "value", "link")


@dataclass(frozen=True, slots=True)
class ColumnSpec:
    """A per-node column a metric promises to produce."""

    name: str
    dtype: str
    semantics: str = "number"
    label: str = ""
    description: str = ""
    render: str = "value"

    @staticmethod
    def from_json(raw: dict) -> "ColumnSpec":
        missing = {"name", "dtype"} - set(raw)
        if missing:
            raise ValueError(f"column spec is missing {sorted(missing)}")
        semantics = raw.get("semantics", "number")
        if semantics not in SEMANTICS:
            raise ValueError(
                f"column {raw['name']!r} declares semantics {semantics!r}; "
                f"known: {sorted(SEMANTICS)}"
            )
        render = raw.get("render", "value")
        if render not in RENDER_HINTS:
            raise ValueError(
                f"column {raw['name']!r} declares render {render!r}; "
                f"known: {sorted(RENDER_HINTS)}"
            )
        return ColumnSpec(
            name=raw["name"], dtype=raw["dtype"], semantics=semantics,
            label=raw.get("label", raw["name"]),
            description=raw.get("description", ""), render=render,
        )


@dataclass(frozen=True, slots=True)
class ScalarSpec:
    """A summary number worth labelling.

    Declaring one is optional: ``summary`` stays free-form, because a tool may
    report numbers nobody anticipated. Declaring gives the frontend a name to
    show instead of a bare key.
    """

    key: str
    label: str = ""
    description: str = ""

    @staticmethod
    def from_json(raw: dict) -> "ScalarSpec":
        if "key" not in raw:
            raise ValueError("scalar spec is missing 'key'")
        return ScalarSpec(
            key=raw["key"],
            label=raw.get("label", raw["key"]),
            description=raw.get("description", ""),
        )


@dataclass(frozen=True, slots=True)
class MetricOutputs:
    """What a metric says it produces.

    An empty ``columns`` list is meaningful and supported: it is how a
    scalar-only metric — a geodesic distance is one number over branch
    lengths — says it has nothing to add per node. Such a metric is fully
    usable, because the colouring comes from correspondence (§9.1).
    """

    scalars: list[ScalarSpec] = field(default_factory=list)
    columns: list[ColumnSpec] = field(default_factory=list)

    @property
    def column_names(self) -> list[str]:
        return sorted(c.name for c in self.columns)

    @staticmethod
    def from_json(raw: dict) -> "MetricOutputs":
        return MetricOutputs(
            scalars=[ScalarSpec.from_json(r) for r in raw.get("summary", [])],
            columns=[ColumnSpec.from_json(r) for r in raw.get("columns", [])],
        )


@dataclass(frozen=True, slots=True)
class MetricSide:
    """A metric's own per-node columns for one side, keyed by column name.

    Every array is indexed by pre-order position and has length ``n_nodes`` of
    that side's tree, so it aligns with the topology a slice serves without a
    key (§1.6). An empty mapping is valid and means "this metric has nothing to
    say per node".
    """

    columns: dict[str, np.ndarray] = field(default_factory=dict)

    def __post_init__(self) -> None:
        lengths = {name: array.shape[0] for name, array in self.columns.items()}
        if len(set(lengths.values())) > 1:
            raise ValueError(f"columns have differing lengths: {lengths}")

    @property
    def n_nodes(self) -> int:
        for array in self.columns.values():
            return int(array.shape[0])
        return 0


@dataclass(frozen=True, slots=True)
class MetricResult:
    """What every metric returns, whatever language computed it."""

    name: str
    #: Scalars for the whole comparison, e.g. {"rf": 6825, "shared_clusters": 10819}.
    #: Free-form because metrics differ; the frontend renders them generically.
    summary: dict[str, float | int | str] = field(default_factory=dict)
    #: Per-node columns, or None when this metric produces none.
    left: MetricSide | None = None
    right: MetricSide | None = None
    #: Anything worth recording that is not a measurement, such as which leaves
    #: reconciliation dropped.
    notes: dict[str, object] = field(default_factory=dict)

    @property
    def column_names(self) -> list[str]:
        return sorted(self.left.columns) if self.left else []


class Metric(Protocol):
    """The in-process interface.

    Correspondence is passed in because it is already computed and a metric
    should never redo it — RF, for one, derives its entire per-clade verdict
    from it.
    """

    def __call__(
        self,
        left: TreeArrays,
        right: TreeArrays,
        correspondence: Correspondence,
    ) -> MetricResult: ...


@dataclass(frozen=True, slots=True)
class MetricManifest:
    """A parsed ``metric.json``."""

    name: str
    title: str
    kind: str  # "python" | "subprocess"
    #: "module:function" for a python metric. Empty for a subprocess metric,
    #: which declares `command` instead.
    entrypoint: str = ""
    description: str = ""
    version: str = "1"
    #: Declared so the frontend can enable or grey out controls without probing:
    #: e.g. {"per_clade": true, "symmetric": true, "weighted": false}.
    capabilities: dict[str, bool] = field(default_factory=dict)
    #: What this metric produces. Declared so a frontend can render a column it
    #: has never seen, and so a metric that fails to produce what it promised
    #: fails at compute time rather than being discovered downstream.
    outputs: MetricOutputs = field(default_factory=MetricOutputs)
    #: The plugin's own directory. Needed so a subprocess command can be
    #: resolved relative to where it lives rather than to the caller's cwd.
    directory: Path | None = None
    #: The manifest as written. Kind-specific configuration — a subprocess
    #: metric's `command`, `input`, `parse` and `timeout_s` — is read from here
    #: rather than promoted into fields that mean nothing for a python metric.
    raw: dict = field(default_factory=dict)

    @staticmethod
    def from_json(raw: dict, directory: Path | None = None) -> "MetricManifest":
        missing = {"name", "title", "kind"} - set(raw)
        if missing:
            raise ValueError(f"metric.json is missing {sorted(missing)}")
        kind = raw["kind"]
        if kind not in ("python", "subprocess"):
            raise ValueError(f"unknown metric kind {kind!r}")
        # Each kind needs its own way in, and neither field is meaningful for
        # the other: requiring both would force every manifest to carry a lie.
        if kind == "python" and not raw.get("entrypoint"):
            raise ValueError(
                f"metric {raw['name']!r} is kind 'python' and needs "
                "'entrypoint': 'module:function'"
            )
        if kind == "subprocess" and not (raw.get("command") or raw.get("entrypoint")):
            raise ValueError(
                f"metric {raw['name']!r} is kind 'subprocess' and needs 'command'"
            )
        return MetricManifest(
            name=raw["name"],
            title=raw["title"],
            kind=kind,
            entrypoint=raw.get("entrypoint", ""),
            description=raw.get("description", ""),
            version=str(raw.get("version", "1")),
            capabilities=raw.get("capabilities", {}),
            outputs=MetricOutputs.from_json(raw.get("outputs", {})),
            directory=directory,
            raw=dict(raw),
        )


def validate_result(result: MetricResult, manifest: MetricManifest) -> None:
    """Check a metric produced what its manifest promised.

    A declaration nobody checks is documentation, and documentation drifts. A
    metric that renames a column, or quietly stops producing one, would
    otherwise be found much later — by a frontend rendering an empty overlay, or
    by nothing at all.
    """
    declared = set(manifest.outputs.column_names)
    for side_name in ("left", "right"):
        side = getattr(result, side_name)
        produced = set(side.columns) if side is not None else set()
        if produced != declared:
            missing = sorted(declared - produced)
            extra = sorted(produced - declared)
            raise ValueError(
                f"metric {manifest.name!r} {side_name} columns do not match its "
                f"manifest: missing {missing}, undeclared {extra}"
            )
        if side is None:
            continue
        for spec in manifest.outputs.columns:
            actual = np.asarray(side.columns[spec.name]).dtype
            # bool is stored as uint8; any other mismatch is a real disagreement
            # about what the column holds.
            if actual == np.bool_ and spec.dtype == "uint8":
                continue
            if actual != np.dtype(spec.dtype):
                raise ValueError(
                    f"metric {manifest.name!r} column {spec.name!r} is {actual}, "
                    f"manifest declares {spec.dtype}"
                )
