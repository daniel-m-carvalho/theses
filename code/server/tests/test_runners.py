"""Running a metric that is a program rather than a function.

The claim being tested is narrow and checkable: **adding a metric written in
another language should be adding configuration, not code.**
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from phylodelta.metrics import registry
from phylodelta.metrics.contract import MetricManifest
from phylodelta.metrics.runners import (
    MetricFailed,
    PreparedPair,
    is_available,
    make_runner,
)
from phylodelta.trees.correspondence import compute_correspondence
from phylodelta.trees.materialise import MaterialisedPair
from phylodelta.trees.newick import parse_newick

PLUGINS = Path(registry.PLUGINS_DIR)


def prepared_pair(tmp_path) -> PreparedPair:
    left = parse_newick("((A:1,B:2)x:3,C:4)r;")
    right = parse_newick("((A:1,C:2)y:3,B:4)r;")
    return PreparedPair(
        pair_id="a__b", left=left, right=right,
        correspondence=compute_correspondence(left, right),
        files=MaterialisedPair(
            pair_id="a__b", left=left, right=right, directory=tmp_path / "scratch"
        ),
    )


def manifest(**overrides) -> MetricManifest:
    base = {
        "name": "demo", "title": "Demo", "kind": "subprocess",
        "command": [sys.executable, "-c", "print('value is: 42')"],
        "parse": {"scalars": [
            {"key": "value", "pattern": "value is: ([0-9]+)", "type": "int"}
        ]},
    }
    return MetricManifest.from_json({**base, **overrides})


# --- the contract ----------------------------------------------------------

def test_a_subprocess_metric_needs_a_command():
    with pytest.raises(ValueError, match="needs 'command'"):
        MetricManifest.from_json({"name": "x", "title": "X", "kind": "subprocess"})


def test_a_python_metric_needs_an_entrypoint():
    with pytest.raises(ValueError, match="entrypoint"):
        MetricManifest.from_json({"name": "x", "title": "X", "kind": "python"})


# --- running ---------------------------------------------------------------

def test_scalars_are_parsed_from_stdout(tmp_path):
    result = make_runner(manifest())(prepared_pair(tmp_path))
    assert result.summary == {"value": 42}
    assert result.left is None, "a scalar-only metric declares no columns"


def test_placeholders_are_substituted(tmp_path):
    """The tool is handed paths to the reconciled trees, written on demand."""
    script = "import sys; print('value is:', len(open(sys.argv[1]).read()))"
    m = manifest(command=[sys.executable, "-c", script, "${left}"])
    result = make_runner(m)(prepared_pair(tmp_path))
    assert result.summary["value"] > 0


def test_lengths_are_included_or_not_as_declared(tmp_path):
    script = "import sys; print('value is:', open(sys.argv[1]).read().count(':'))"
    with_lengths = manifest(
        command=[sys.executable, "-c", script, "${left}"],
        input={"format": "newick", "include_lengths": True},
    )
    without = manifest(
        command=[sys.executable, "-c", script, "${left}"],
        input={"format": "newick", "include_lengths": False},
    )
    assert make_runner(with_lengths)(prepared_pair(tmp_path)).summary["value"] > 0
    # Not cosmetic: TreeDiff infers weighted mode from the first ':' it sees.
    assert make_runner(without)(prepared_pair(tmp_path)).summary["value"] == 0


def test_files_are_written_once_per_form(tmp_path):
    pair = prepared_pair(tmp_path)
    script = "import sys; print('value is: 1')"
    m = manifest(command=[sys.executable, "-c", script, "${left}", "${right}"])
    make_runner(m)(pair)
    make_runner(m)(pair)
    assert len(list((tmp_path / "scratch").iterdir())) == 2


# --- failing loudly --------------------------------------------------------

def test_a_nonzero_exit_is_reported_with_stderr(tmp_path):
    m = manifest(command=[sys.executable, "-c",
                          "import sys; sys.stderr.write('bad tree'); sys.exit(3)"])
    with pytest.raises(MetricFailed, match="exited 3"):
        make_runner(m)(prepared_pair(tmp_path))


def test_output_that_does_not_match_is_not_silently_empty(tmp_path):
    """A tool changing its output format must fail, not report nothing."""
    m = manifest(command=[sys.executable, "-c", "print('surprising output')"])
    with pytest.raises(MetricFailed, match="no match for 'value'"):
        make_runner(m)(prepared_pair(tmp_path))


def test_an_optional_scalar_may_be_absent(tmp_path):
    m = manifest(
        command=[sys.executable, "-c", "print('value is: 7')"],
        parse={"scalars": [
            {"key": "value", "pattern": "value is: ([0-9]+)", "type": "int"},
            {"key": "extra", "pattern": "extra: ([0-9]+)", "type": "int",
             "required": False},
        ]},
    )
    assert make_runner(m)(prepared_pair(tmp_path)).summary == {"value": 7}


def test_a_timeout_is_reported(tmp_path):
    m = manifest(command=[sys.executable, "-c", "import time; time.sleep(30)"],
                 timeout_s=0.5)
    with pytest.raises(MetricFailed, match="did not finish"):
        make_runner(m)(prepared_pair(tmp_path))


def test_a_missing_binary_says_so(tmp_path):
    m = manifest(command=["/nonexistent/tool", "${left}"])
    with pytest.raises(MetricFailed, match="not built"):
        make_runner(m)(prepared_pair(tmp_path))


def test_an_unbuilt_metric_is_listed_but_marked_unavailable():
    assert is_available(manifest(command=["/nonexistent/tool"])) is False
    assert is_available(manifest(command=[sys.executable])) is True


def test_an_unimplemented_input_format_is_refused(tmp_path):
    m = manifest(input={"format": "nexus"})
    with pytest.raises(MetricFailed, match="only 'newick'"):
        make_runner(m)


# --- the shipped triplet metric --------------------------------------------

def test_triplet_is_configuration_only():
    """The claim, asserted: adding it added no code."""
    directory = PLUGINS / "triplet_treediff"
    assert directory.is_dir()
    files = sorted(p.name for p in directory.iterdir() if p.is_file())
    assert files == ["metric.json"], f"expected configuration only, found {files}"


def test_triplet_is_registered_and_declares_no_columns():
    m = registry.discover()["triplet"]
    assert m.kind == "subprocess"
    assert m.outputs.column_names == []
    assert m.capabilities["per_clade"] is False


@pytest.mark.skipif(
    not is_available(registry.discover().get("triplet", manifest())),
    reason="TreeDiff is not built; see native/build_treediff.sh",
)
def test_triplet_runs_on_a_small_pair(tmp_path):
    result = registry.load("triplet")(prepared_pair(tmp_path))
    assert result.summary["triplet"] >= 0
    assert result.left is None
