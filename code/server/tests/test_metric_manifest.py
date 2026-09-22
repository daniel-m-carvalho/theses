"""Declared outputs: what a metric promises, and whether it delivers.

A declaration nobody checks is documentation, and documentation drifts. These
tests cover both halves — parsing the declaration, and enforcing it against what
a metric actually returned.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from phylodelta.metrics.contract import (
    ColumnSpec,
    MetricManifest,
    MetricOutputs,
    MetricResult,
    MetricSide,
    ScalarSpec,
    validate_result,
)

BASE = {
    "name": "demo",
    "title": "Demo",
    "kind": "python",
    "entrypoint": "does.not:matter",
}


def manifest(outputs: dict | None = None) -> MetricManifest:
    return MetricManifest.from_json({**BASE, "outputs": outputs or {}})


# --- parsing ---------------------------------------------------------------

def test_a_manifest_without_outputs_declares_nothing():
    m = manifest()
    assert m.outputs.columns == [] and m.outputs.scalars == []


def test_columns_and_scalars_are_parsed():
    m = manifest({
        "summary": [{"key": "rf", "label": "Robinson-Foulds"}],
        "columns": [{"name": "exact", "dtype": "uint8", "semantics": "boolean",
                     "render": "overlay", "label": "Preserved"}],
    })
    assert m.outputs.column_names == ["exact"]
    assert m.outputs.columns[0].semantics == "boolean"
    assert m.outputs.columns[0].render == "overlay"
    assert m.outputs.scalars[0].label == "Robinson-Foulds"


def test_label_defaults_to_the_name():
    m = manifest({"columns": [{"name": "agreement", "dtype": "float32"}]})
    assert m.outputs.columns[0].label == "agreement"


def test_unknown_semantics_is_refused():
    with pytest.raises(ValueError, match="semantics"):
        manifest({"columns": [{"name": "x", "dtype": "uint8", "semantics": "vibes"}]})


def test_unknown_render_hint_is_refused():
    with pytest.raises(ValueError, match="render"):
        manifest({"columns": [{"name": "x", "dtype": "uint8", "render": "interpretive dance"}]})


def test_a_column_needs_a_name_and_a_dtype():
    with pytest.raises(ValueError, match="dtype"):
        manifest({"columns": [{"name": "x"}]})


# --- enforcement -----------------------------------------------------------

def sides(**columns) -> dict:
    return {"left": MetricSide(columns=dict(columns)),
            "right": MetricSide(columns=dict(columns))}


def test_a_metric_producing_what_it_declared_passes():
    m = manifest({"columns": [{"name": "exact", "dtype": "uint8"}]})
    result = MetricResult(name="demo", **sides(exact=np.zeros(4, dtype=np.uint8)))
    validate_result(result, m)


def test_a_bool_column_satisfies_a_uint8_declaration():
    """numpy bool_ is one byte; naming it uint8 on disk is readable anywhere."""
    m = manifest({"columns": [{"name": "exact", "dtype": "uint8"}]})
    result = MetricResult(name="demo", **sides(exact=np.zeros(4, dtype=bool)))
    validate_result(result, m)


def test_a_missing_column_is_caught():
    m = manifest({"columns": [{"name": "exact", "dtype": "uint8"}]})
    with pytest.raises(ValueError, match="missing \\['exact'\\]"):
        validate_result(MetricResult(name="demo", **sides()), m)


def test_an_undeclared_column_is_caught():
    """A renamed column would otherwise surface as an empty overlay, or not at all."""
    m = manifest({"columns": [{"name": "exact", "dtype": "uint8"}]})
    result = MetricResult(name="demo", **sides(exakt=np.zeros(4, dtype=np.uint8)))
    with pytest.raises(ValueError, match="undeclared \\['exakt'\\]"):
        validate_result(result, m)


def test_a_wrong_dtype_is_caught():
    m = manifest({"columns": [{"name": "score", "dtype": "float32"}]})
    result = MetricResult(name="demo", **sides(score=np.zeros(4, dtype=np.uint8)))
    with pytest.raises(ValueError, match="declares float32"):
        validate_result(result, m)


def test_declaring_nothing_and_producing_nothing_is_valid():
    """The geodesic case: one number, nothing per node."""
    validate_result(MetricResult(name="geodesic", summary={"geodesic": 1.5}), manifest())


def test_declaring_nothing_but_producing_something_is_caught():
    result = MetricResult(name="demo", **sides(surprise=np.zeros(4, dtype=np.uint8)))
    with pytest.raises(ValueError, match="undeclared"):
        validate_result(result, manifest())


# --- the shipped manifest --------------------------------------------------

def test_rf_declares_what_it_produces(real_store):
    from phylodelta.metrics import registry
    from phylodelta.metrics.plugins.rf_python.rf import compute
    from phylodelta.trees.correspondence import compute_correspondence
    from phylodelta.trees.newick import parse_newick

    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    result = compute(a, b, compute_correspondence(a, b))
    validate_result(result, registry.discover()["rf"])


def test_every_shipped_manifest_parses():
    from phylodelta.metrics import registry

    for name, m in registry.discover().items():
        assert m.name == name
        assert m.directory is not None
        for column in m.outputs.columns:
            assert column.dtype
