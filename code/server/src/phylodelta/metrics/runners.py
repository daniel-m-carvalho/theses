"""Invoking a metric, whatever it is written in.

Two kinds, chosen by the manifest, behind one interface so the pipeline does not
branch:

``python``
    Imported and called in-process. Receives the trees and the pair's
    correspondence directly.

``subprocess``
    A program. Receives file paths, returns text, and is parsed according to its
    manifest. This is what makes "a metric may be written in any language" true
    rather than aspirational: a C++ binary, an R script or a Java jar all
    qualify, and none of them needs a Python binding.

Why subprocess is the right mechanism here, not a fallback
----------------------------------------------------------
A metric runs **once per pair, offline**, and takes seconds. Process startup is
a millisecond. There is no per-call overhead worth avoiding, and the alternative
— an in-process binding per language — means four build toolchains and four ways
to fail on a deployment machine. In-process binding is reserved for the hot
paths (parsing, the store, correspondence), which are this project's own code
and therefore only ever one toolchain.

What a subprocess metric may return
-----------------------------------
Scalars, parsed from stdout by patterns its manifest declares. That is enough
for every metric currently in view — RF, triplet, quartet and geodesic all print
a number — and it is enough because **per-clade colouring does not come from the
metric** (§9.1). A tool with structured per-clade output would need a parser for
its shape; none of the candidates has one, so that is deliberately not built.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .. import config
from ..trees.correspondence import Correspondence
from ..trees.materialise import MaterialisedPair
from ..trees.newick import TreeArrays
from .contract import MetricManifest, MetricResult

#: A metric that has not returned in this long is not going to. Overridable per
#: manifest; the default is generous because these are offline computations, and
#: the point of the limit is to fail rather than hang a batch overnight.
DEFAULT_TIMEOUT_S = 3600


class MetricFailed(RuntimeError):
    """A metric could not be run, or did not produce what its manifest promised."""


@dataclass
class PreparedPair:
    """Everything shared, computed once, handed to every metric for this pair."""

    pair_id: str
    left: TreeArrays
    right: TreeArrays
    correspondence: Correspondence
    #: Writes the reconciled trees out only if some metric actually asks for
    #: them, and only once per form however many metrics ask.
    files: MaterialisedPair


class Runner(Protocol):
    def __call__(self, prepared: PreparedPair) -> MetricResult: ...


# --- python ----------------------------------------------------------------


def _python_runner(manifest: MetricManifest) -> Runner:
    import importlib

    module_name, _, attr = manifest.entrypoint.partition(":")
    if not attr:
        raise MetricFailed(
            f"metric {manifest.name!r} has entrypoint {manifest.entrypoint!r}; "
            "a python metric needs 'module:function'"
        )
    function = getattr(importlib.import_module(module_name), attr)

    def run(prepared: PreparedPair) -> MetricResult:
        return function(prepared.left, prepared.right, prepared.correspondence)

    return run


# --- subprocess ------------------------------------------------------------


def _substitute(token: str, mapping: dict[str, str]) -> str:
    """Expand ``${name}`` placeholders, then environment variables."""
    for key, value in mapping.items():
        token = token.replace("${" + key + "}", value)
    return os.path.expandvars(token)


def _coerce(text: str, kind: str):
    if kind == "int":
        # Some tools print an integral value in float form.
        return int(float(text))
    if kind == "float":
        return float(text)
    return text


def _parse_stdout(stdout: str, spec: dict, name: str) -> dict:
    """Pull declared scalars out of a tool's output."""
    summary: dict = {}
    for scalar in spec.get("scalars", []):
        pattern = scalar["pattern"]
        match = re.search(pattern, stdout)
        if match is None:
            if scalar.get("required", True):
                raise MetricFailed(
                    f"metric {name!r} produced no match for {scalar['key']!r} "
                    f"(pattern {pattern!r}).\nIts output was:\n{stdout.strip()[:800]}"
                )
            continue
        summary[scalar["key"]] = _coerce(match.group(1), scalar.get("type", "float"))
    return summary


def _subprocess_runner(manifest: MetricManifest) -> Runner:
    raw = manifest.raw
    command: list[str] = raw.get("command") or shlex.split(manifest.entrypoint or "")
    if not command:
        raise MetricFailed(
            f"metric {manifest.name!r} declares kind 'subprocess' but no 'command'"
        )
    input_spec = raw.get("input", {})
    if input_spec.get("format", "newick") != "newick":
        raise MetricFailed(
            f"metric {manifest.name!r} wants input format "
            f"{input_spec.get('format')!r}; only 'newick' is implemented"
        )
    include_lengths = bool(input_spec.get("include_lengths", False))
    timeout = float(raw.get("timeout_s", DEFAULT_TIMEOUT_S))

    def run(prepared: PreparedPair) -> MetricResult:
        mapping = {
            "left": str(prepared.files.newick("left", include_lengths)),
            "right": str(prepared.files.newick("right", include_lengths)),
            "plugin": str(manifest.directory or ""),
            "native": str(config.NATIVE_DIR),
            "pair": prepared.pair_id,
        }
        argv = [_substitute(token, mapping) for token in command]

        executable = Path(argv[0])
        if not executable.exists():
            raise MetricFailed(
                f"metric {manifest.name!r} needs {executable}, which is not built. "
                f"See native/ for how to build it."
            )
        try:
            completed = subprocess.run(
                argv, capture_output=True, text=True, timeout=timeout, check=False
            )
        except subprocess.TimeoutExpired:
            raise MetricFailed(
                f"metric {manifest.name!r} did not finish within {timeout:,.0f}s"
            ) from None
        if completed.returncode != 0:
            raise MetricFailed(
                f"metric {manifest.name!r} exited {completed.returncode}.\n"
                f"command: {' '.join(argv)}\n"
                f"stderr: {completed.stderr.strip()[:800]}"
            )

        summary = _parse_stdout(completed.stdout, raw.get("parse", {}), manifest.name)
        return MetricResult(name=manifest.name, summary=summary)

    return run


def make_runner(manifest: MetricManifest) -> Runner:
    if manifest.kind == "python":
        return _python_runner(manifest)
    if manifest.kind == "subprocess":
        return _subprocess_runner(manifest)
    raise MetricFailed(f"metric {manifest.name!r} has unknown kind {manifest.kind!r}")


def is_available(manifest: MetricManifest) -> bool:
    """Whether this metric could run now.

    A subprocess metric whose binary has not been built is still *listed* — it
    exists and is configured — but a client should not offer it. Saying so is
    better than letting the user pick it and get an error.
    """
    if manifest.kind != "subprocess":
        return True
    command = manifest.raw.get("command") or shlex.split(manifest.entrypoint or "")
    if not command:
        return False
    resolved = _substitute(command[0], {"native": str(config.NATIVE_DIR),
                                        "plugin": str(manifest.directory or "")})
    return Path(resolved).exists()
