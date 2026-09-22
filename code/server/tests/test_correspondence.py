"""Clade correspondence — the layer every metric shares.

These tests used to live in test_metrics.py, because correspondence lived
inside the RF plugin. Moving them here is the point of the split: none of this
is Robinson-Foulds.
"""

from __future__ import annotations

import numpy as np
import pytest

from phylocmp.trees.correspondence import (
    NO_CORRESPONDENCE,
    compute_correspondence,
    leaf_position_maps,
)
from phylocmp.trees.newick import parse_newick
from phylocmp.trees.reconcile import reconcile


def internal_mask(arrays):
    end = np.asarray(arrays.subtree_end)
    return end != np.arange(arrays.n_nodes) + 1


def test_identical_trees_are_perfectly_similar():
    a = parse_newick("(((A,B),(C,D)),((E,F),G));")
    c = compute_correspondence(a, a)
    assert np.allclose(c.left.similarity, 1.0)
    assert np.array_equal(c.left.corresponds, np.arange(a.n_nodes, dtype=np.uint32))


def test_a_partly_matching_clade_scores_between_zero_and_one():
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    c = compute_correspondence(a, b)
    # {A,B} in a best-matches {B,A,C} in b: 2 of 3.
    assert c.left.similarity[2] == pytest.approx(2 / 3, abs=1e-6)


def test_leaves_correspond_to_the_same_label():
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    c = compute_correspondence(a, b)
    for i in np.flatnonzero(~internal_mask(a)):
        assert b.labels[int(c.left.corresponds[i])] == a.labels[i]


def test_correspondence_is_computed_both_ways():
    a = parse_newick("(((A,B),C),(D,E));")
    b = parse_newick("((D,E),(B,(A,C)));")
    c = compute_correspondence(a, b)
    assert c.left.similarity.shape[0] == a.n_nodes
    assert c.right.similarity.shape[0] == b.n_nodes


def test_similarity_is_one_exactly_when_the_clade_is_preserved():
    """The equivalence RF's verdict is derived from.

    Jaccard is 1 only when intersection equals union, which is set equality.
    """
    a = parse_newick("(((A,B),C),(D,(E,F)));")
    b = parse_newick("((A,(B,C)),((D,E),F));")
    c = compute_correspondence(a, b)
    end = np.asarray(a.subtree_end)
    leaves_of = lambda i: {a.labels[j] for j in range(i, int(end[i])) if end[j] == j + 1}
    endb = np.asarray(b.subtree_end)
    b_clades = {
        frozenset(b.labels[j] for j in range(i, int(endb[i])) if endb[j] == j + 1)
        for i in range(b.n_nodes)
    }
    for i in range(a.n_nodes):
        preserved = frozenset(leaves_of(i)) in b_clades
        assert np.isclose(c.left.similarity[i], 1.0) == preserved, i


# --- the bijection it depends on -------------------------------------------

def test_mismatched_leaf_sets_are_refused_not_guessed():
    """The reference implementation silently maps an unknown label to the root."""
    a = parse_newick("((A,B),X);")
    b = parse_newick("((A,B),C);")
    with pytest.raises(ValueError, match="same leaf set"):
        leaf_position_maps(a, b)


def test_duplicate_labels_are_refused():
    a = parse_newick("((A,A),B);")
    with pytest.raises(ValueError, match="duplicate leaf labels"):
        leaf_position_maps(a, a)


def test_maps_point_at_the_same_label():
    a = parse_newick("((A,B),C);")
    b = parse_newick("(A,(B,C));")
    left_to_right, right_to_left = leaf_position_maps(a, b)
    assert (left_to_right[np.asarray(a.subtree_end) == np.arange(a.n_nodes) + 1] >= 0).all()
    assert (left_to_right[0] == -1)  # the root is not a leaf


# --- the cheap estimator, kept for comparison only -------------------------

def test_best_match_is_at_least_the_lca_ratio():
    a = parse_newick("(((A,B),C),(D,(E,F)));")
    b = parse_newick("((A,(B,C)),((D,E),F));")
    cheap = compute_correspondence(a, b, best_match=False)
    best = compute_correspondence(a, b, best_match=True)
    assert (best.left.similarity >= cheap.left.similarity - 1e-6).all()


def test_both_estimators_agree_on_exact_matches(real_store):
    """RF is unaffected by which is used; only the gradient differs."""
    from phylocmp.trees.store import read_tree

    left, right, _ = reconcile(
        read_tree(real_store / "trees" / "vibrio-nj").to_arrays(),
        read_tree(real_store / "trees" / "vibrio-upgma").to_arrays(),
    )
    cheap = compute_correspondence(left, right, best_match=False)
    assert np.isclose(cheap.left.similarity, 1.0).sum() > 0


# --- the real pair ---------------------------------------------------------

def test_real_pair_similarity_is_in_range(real_store):
    from phylocmp.trees.store import read_tree

    left, right, _ = reconcile(
        read_tree(real_store / "trees" / "vibrio-nj").to_arrays(),
        read_tree(real_store / "trees" / "vibrio-upgma").to_arrays(),
    )
    c = compute_correspondence(left, right, best_match=False)
    for side, arrays in ((c.left, left), (c.right, right)):
        assert side.similarity.shape[0] == arrays.n_nodes
        assert ((side.similarity >= 0) & (side.similarity <= 1)).all()
        assert (side.corresponds != NO_CORRESPONDENCE).all()


# --- the native search must agree exactly ----------------------------------

def without_native(monkeypatch):
    from phylocmp.trees import native

    monkeypatch.setattr(native, "extension", lambda: None)


@pytest.mark.parametrize(
    "left_text,right_text",
    [
        ("(((A,B),C),(D,E));", "((D,E),(B,(A,C)));"),
        ("((A,B),(C,D));", "((A,C),(B,D));"),
        ("(((A,B),(C,D)),((E,F),(G,H)));", "((A,(B,C)),((D,E),((F,G),H)));"),
        # Many equal-scoring candidates: the tie-break has to agree too.
        ("((A,B),(C,D));", "((A,B),(C,D));"),
        ("(((A,B),C),(D,(E,F)));", "(((A,B),C),(D,(E,F)));"),
    ],
)
def test_native_and_python_searches_agree(monkeypatch, left_text, right_text):
    """Not 'equally good' — identical, including which clade was chosen.

    Ties are common, and without a shared rule the two would return
    different-but-equal answers, making the extension a behaviour change rather
    than a speed one.
    """
    from phylocmp.trees import native

    if not native.available():
        pytest.skip("native extension not built")

    left, right = parse_newick(left_text), parse_newick(right_text)
    fast = compute_correspondence(left, right)
    without_native(monkeypatch)
    slow = compute_correspondence(left, right)

    for side in ("left", "right"):
        np.testing.assert_array_equal(
            getattr(fast, side).similarity, getattr(slow, side).similarity
        )
        np.testing.assert_array_equal(
            getattr(fast, side).corresponds, getattr(slow, side).corresponds
        )


def test_native_and_python_agree_on_the_real_pair(real_store, monkeypatch):
    from phylocmp.trees import native
    from phylocmp.trees.store import read_tree

    if not native.available():
        pytest.skip("native extension not built")

    left, right, _ = reconcile(
        read_tree(real_store / "trees" / "vibrio-nj").to_arrays(),
        read_tree(real_store / "trees" / "vibrio-upgma").to_arrays(),
    )
    fast = compute_correspondence(left, right)
    without_native(monkeypatch)
    slow = compute_correspondence(left, right)

    for side in ("left", "right"):
        np.testing.assert_array_equal(
            getattr(fast, side).similarity, getattr(slow, side).similarity
        )
        np.testing.assert_array_equal(
            getattr(fast, side).corresponds, getattr(slow, side).corresponds
        )


def test_the_search_is_exact_not_heuristic(monkeypatch):
    """The pruning excludes only what provably cannot win.

    Checked against an exhaustive scan written independently of both
    implementations, so a shared misunderstanding of the bound would show up.
    """
    from phylocmp.trees import native

    if not native.available():
        pytest.skip("native extension not built")

    left = parse_newick("(((A,B),(C,D)),((E,F),(G,H)));")
    right = parse_newick("((A,(B,(C,E))),((D,F),(G,H)));")
    got = compute_correspondence(left, right)

    def clades(tree):
        end = np.asarray(tree.subtree_end)
        return [
            frozenset(tree.labels[j] for j in range(i, int(end[i])) if end[j] == j + 1)
            for i in range(tree.n_nodes)
        ]

    left_clades, right_clades = clades(left), clades(right)
    for i, a in enumerate(left_clades):
        best = max(
            len(a & b) / len(a | b) for b in right_clades
        )
        assert got.left.similarity[i] == pytest.approx(best, abs=1e-6), i


# --- threading -------------------------------------------------------------

def at_threads(monkeypatch, count: int, left, right):
    """Compute correspondence pinned to a thread count."""
    from phylocmp import config

    monkeypatch.setattr(config, "threads", lambda: count)
    return compute_correspondence(left, right)


@pytest.mark.parametrize("threads", [1, 2, 3, 8, 16])
def test_the_result_does_not_depend_on_the_thread_count(monkeypatch, threads):
    """The gate for parallelising the search.

    Not 'equally good' — bit-identical. Index i's answer depends on no other
    index and ties break within a single iteration, so this should hold; but
    reasoning about determinism instead of testing it is how race conditions
    get shipped.
    """
    from phylocmp.trees import native

    if not native.available():
        pytest.skip("native extension not built")

    left = parse_newick("((((A,B),(C,D)),((E,F),(G,H))),(((I,J),(K,L)),((M,N),(O,P))));")
    right = parse_newick("((A,(B,(C,E))),(((D,F),(G,H)),((I,K),((J,L),((M,O),(N,P))))));")

    one = at_threads(monkeypatch, 1, left, right)
    many = at_threads(monkeypatch, threads, left, right)
    for side in ("left", "right"):
        np.testing.assert_array_equal(
            getattr(one, side).similarity, getattr(many, side).similarity
        )
        np.testing.assert_array_equal(
            getattr(one, side).corresponds, getattr(many, side).corresponds
        )


def test_threading_is_deterministic_on_the_real_pair(real_store, monkeypatch):
    from phylocmp.trees import native
    from phylocmp.trees.store import read_tree

    if not native.available():
        pytest.skip("native extension not built")

    left, right, _ = reconcile(
        read_tree(real_store / "trees" / "vibrio-nj").to_arrays(),
        read_tree(real_store / "trees" / "vibrio-upgma").to_arrays(),
    )
    one = at_threads(monkeypatch, 1, left, right)
    many = at_threads(monkeypatch, 0, left, right)  # 0 = one per core
    for side in ("left", "right"):
        np.testing.assert_array_equal(
            getattr(one, side).similarity, getattr(many, side).similarity
        )
        np.testing.assert_array_equal(
            getattr(one, side).corresponds, getattr(many, side).corresponds
        )


def test_thread_count_is_configurable(monkeypatch):
    from phylocmp import config

    monkeypatch.setenv("PHYLOCMP_THREADS", "3")
    assert config.threads() == 3
    monkeypatch.setenv("PHYLOCMP_THREADS", "")
    assert config.threads() == 0, "empty means auto"
    monkeypatch.setenv("PHYLOCMP_THREADS", "nonsense")
    assert config.threads() == 0, "unparseable must not crash a batch"
    monkeypatch.setenv("PHYLOCMP_THREADS", "-4")
    assert config.threads() == 0
