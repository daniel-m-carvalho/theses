"""Our Robinson-Foulds against an independent implementation.

Not a benchmark. TreeDiff is the reference implementation of the paper this
backend follows — different authors, a different algorithm, over a different
representation — so agreement is evidence that neither is wrong in a way the
other shares.

That matters more here than it usually would. Of the five RF implementations
examined for this project, **three return wrong answers on real input**, all of
them silently: `rf_day` scores a tree against itself as 11,831 (§2.5),
`phylodiff` shares one iterator across its outer loop, and TreeDiff's own
weighted variant accumulates in float32 and reports -28.49 where the answer is
zero (§2.3). A confident number is not evidence of a correct one.
"""

from __future__ import annotations

import pytest

from phylocmp.metrics import registry
from phylocmp.metrics.plugins.rf_python.rf import compute
from phylocmp.metrics.runners import PreparedPair, is_available
from phylocmp.trees.correspondence import compute_correspondence
from phylocmp.trees.materialise import MaterialisedPair
from phylocmp.trees.newick import parse_newick
from phylocmp.trees.reconcile import reconcile

METRIC = "rf-treediff"


def treediff_available() -> bool:
    manifest = registry.discover().get(METRIC)
    return manifest is not None and is_available(manifest)


pytestmark = pytest.mark.skipif(
    not treediff_available(),
    reason="TreeDiff is not built; see native/build_treediff.sh",
)


def prepare(tmp_path, left, right) -> PreparedPair:
    return PreparedPair(
        pair_id="a__b", left=left, right=right,
        correspondence=compute_correspondence(left, right),
        files=MaterialisedPair(
            pair_id="a__b", left=left, right=right, directory=tmp_path / "scratch"
        ),
    )


def both(tmp_path, left, right) -> tuple[float, float]:
    prepared = prepare(tmp_path, left, right)
    ours = compute(left, right, prepared.correspondence).summary["rf"]
    theirs = registry.load(METRIC)(prepared).summary["rf"]
    return float(ours), float(theirs)


@pytest.mark.parametrize(
    "left_text,right_text",
    [
        ("(((A,B),C),(D,E));", "((D,E),(B,(A,C)));"),     # the paper's own example
        ("((A,B),(C,D));", "((A,B),(C,D));"),             # identical
        ("((A,B),(C,D));", "((A,C),(B,D));"),
        ("(((A,B),(C,D)),((E,F),(G,H)));", "((A,(B,(C,D))),((E,F),(G,H)));"),
        ("((((A,B),C),D),E);", "(A,(B,(C,(D,E))));"),     # caterpillars
    ],
)
def test_the_two_implementations_agree(tmp_path, left_text, right_text):
    ours, theirs = both(tmp_path, parse_newick(left_text), parse_newick(right_text))
    assert ours == theirs


def test_they_agree_on_the_real_pair(real_store, tmp_path):
    """The gate that has stood since milestone 2, now checked from both sides."""
    from phylocmp.trees.store import read_tree

    left, right, _ = reconcile(
        read_tree(real_store / "trees" / "vibrio-nj").to_arrays(),
        read_tree(real_store / "trees" / "vibrio-upgma").to_arrays(),
    )
    ours, theirs = both(tmp_path, left, right)
    assert ours == 6825
    assert theirs == 6825


def test_a_tree_against_itself_is_zero_both_ways(real_store, tmp_path):
    """The control that exposed two defects in other implementations."""
    from phylocmp.trees.store import read_tree

    arrays = read_tree(real_store / "trees" / "vibrio-nj").to_arrays()
    ours, theirs = both(tmp_path, arrays, arrays)
    assert ours == 0
    assert theirs == 0


def test_the_metric_is_configuration_only():
    directory = registry.PLUGINS_DIR / "rf_treediff"
    files = sorted(p.name for p in directory.iterdir() if p.is_file())
    assert files == ["metric.json"], f"expected configuration only, found {files}"


def test_it_declares_no_per_node_columns():
    """It contributes a number. The gradient comes from correspondence."""
    manifest = registry.discover()[METRIC]
    assert manifest.outputs.column_names == []
    assert manifest.capabilities["per_clade"] is False
