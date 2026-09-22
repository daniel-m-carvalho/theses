"""The Robinson-Foulds metric, and the registry that finds it.

Correspondence is tested in test_correspondence.py; this file is only about the
distance. That separation is the point of the split — most of what used to be
here was never RF.
"""

from __future__ import annotations

import numpy as np
import pytest

from phylodelta.metrics import registry
from phylodelta.metrics.plugins.rf_python.rf import compute
from phylodelta.trees.correspondence import compute_correspondence
from phylodelta.trees.newick import parse_newick
from phylodelta.trees.reconcile import reconcile

#: Milestone 2's gate, from the reference implementation (DECISIONS.md §2.6).
VIBRIO_RF = 6825
VIBRIO_SHARED = 10_819


def rf(left, right, best_match: bool = True):
    """Run the metric the way the pipeline does: correspondence first."""
    return compute(left, right, compute_correspondence(left, right, best_match))


def internal_mask(arrays):
    end = np.asarray(arrays.subtree_end)
    return end != np.arange(arrays.n_nodes) + 1


# --- the distance ----------------------------------------------------------

def test_matches_the_papers_documented_example():
    """TreeDiff reports RF=1 with exclusive clusters at its 1-based 3 and 7."""
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    r = rf(a, b)
    assert r.summary["rf"] == 1
    # TreeDiff is 1-based, this store is 0-based (§2.6): its 3 and 7 are our 2 and 6.
    exact_left = r.left.columns["exact"]
    exact_right = r.right.columns["exact"]
    assert list(np.flatnonzero(internal_mask(a) & ~exact_left)) == [2]
    assert list(np.flatnonzero(internal_mask(b) & ~exact_right)) == [6]


def test_identical_trees_score_zero():
    a = parse_newick("(((A,B),(C,D)),((E,F),G));")
    r = rf(a, a)
    assert r.summary["rf"] == 0
    assert r.left.columns["exact"][internal_mask(a)].all()


def test_is_symmetric():
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    assert rf(a, b).summary["rf"] == rf(b, a).summary["rf"]


def test_the_verdict_is_derived_from_correspondence():
    """`exact` is `similarity == 1.0`, not a second traversal."""
    a = parse_newick("(((A,B),C),(D,(E,F)));")
    b = parse_newick("((A,(B,C)),((D,E),F));")
    c = compute_correspondence(a, b)
    r = compute(a, b, c)
    np.testing.assert_array_equal(
        r.left.columns["exact"], np.isclose(c.left.similarity, 1.0)
    )


def test_rf_does_not_depend_on_which_estimator_produced_similarity():
    """The gradient differs between estimators; the distance must not."""
    a = parse_newick("(((A,B),C),(D,(E,F)));")
    b = parse_newick("((A,(B,C)),((D,E),F));")
    assert rf(a, b, best_match=True).summary["rf"] == rf(a, b, best_match=False).summary["rf"]


def test_declares_only_its_own_column():
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    assert rf(a, b).column_names == ["exact"]


# --- the registry ----------------------------------------------------------

def test_rf_is_discoverable_and_loadable():
    manifests = registry.discover()
    assert "rf" in manifests
    assert manifests["rf"].capabilities["per_clade"] is True
    assert manifests["rf"].directory is not None, "needed to resolve a subprocess entrypoint"
    assert callable(registry.load("rf"))


def test_unknown_metric_raises():
    with pytest.raises(registry.MetricNotFound):
        registry.load("does-not-exist")


# --- the real pair: milestone 2's gate -------------------------------------

@pytest.fixture(scope="session")
def vibrio_pair(real_store):
    from phylodelta.trees.store import read_tree

    left = read_tree(real_store / "trees" / "vibrio-nj").to_arrays()
    right = read_tree(real_store / "trees" / "vibrio-upgma").to_arrays()
    return reconcile(left, right)


def test_reconciliation_drops_only_st_211(vibrio_pair):
    _, _, report = vibrio_pair
    assert report.shared == 17_645
    assert report.dropped_left == []
    assert report.dropped_right == ["211"]


def test_rf_matches_the_reference_implementation(vibrio_pair):
    left, right, _ = vibrio_pair
    r = rf(left, right, best_match=False)
    assert r.summary["rf"] == VIBRIO_RF
    assert r.summary["shared_clusters"] == VIBRIO_SHARED


def test_self_comparison_of_a_real_tree_is_zero(real_store):
    """The control that caught two defects in other implementations (§2.3, §2.5)."""
    from phylodelta.trees.store import read_tree

    arrays = read_tree(real_store / "trees" / "vibrio-nj").to_arrays()
    r = rf(arrays, arrays, best_match=False)
    assert r.summary["rf"] == 0
    assert r.left.columns["exact"][internal_mask(arrays)].all()


def test_cross_species_comparison_runs_and_reports_what_it_matched(real_store):
    """Comparing different species is allowed; the result carries its own caveat."""
    from phylodelta.trees.store import read_tree

    left = read_tree(real_store / "trees" / "clostridium-upgma").to_arrays()
    right = read_tree(real_store / "trees" / "vibrio-upgma").to_arrays()
    left_r, right_r, report = reconcile(left, right)
    assert report.shared == 17_490
    assert len(report.dropped_left) == 10_472
    assert len(report.dropped_right) == 156

    r = rf(left_r, right_r, best_match=False)
    # Near-maximal distance and almost nothing shared: label collision is not
    # biological correspondence, and the numbers say so without being blocked.
    assert r.summary["shared_clusters"] < 10
    assert r.summary["rf_normalised"] > 0.49
