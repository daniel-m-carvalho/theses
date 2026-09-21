"""The succinct store, against the columnar one it must agree with.

The gate is equivalence: a slice must be identical whichever store served it.
The columnar store stays the reference — it produced the numbers this project
reports — so every test here is a comparison, not an assertion about succinct
behaviour in isolation.
"""

from __future__ import annotations

import numpy as np
import pytest

from phylocmp.trees import native
from phylocmp.trees.newick import NO_PARENT, parse_newick
from phylocmp.trees.store import TreeMeta, read_tree, store_bytes, write_tree
from phylocmp.trees.succinct_store import (
    NativeRequired,
    read_succinct_tree,
    to_balanced_parens,
    write_succinct_tree,
)
from phylocmp.trees.summarise import Summariser, flatten

pytestmark = pytest.mark.skipif(
    not native.available(),
    reason="native extension not built; run native/build.sh",
)

BUDGETS = [1, 2, 7, 25, 100, 500]


def both_stores(tmp_path, arrays):
    meta = TreeMeta(id="t", species="s", method="upgma", source="",
                    n_nodes=0, n_leaves=0, max_depth=0)
    write_tree(tmp_path / "columnar", arrays, meta)
    write_succinct_tree(tmp_path / "succinct", arrays, meta)
    return read_tree(tmp_path / "columnar"), read_succinct_tree(tmp_path / "succinct")


# --- the representation ----------------------------------------------------

def test_balanced_parens_has_two_characters_per_node():
    arrays = parse_newick("((A,B),(C,D));")
    parens = to_balanced_parens(arrays)
    assert len(parens) == 2 * arrays.n_nodes
    assert parens.count("(") == parens.count(")") == arrays.n_nodes


def test_balanced_parens_is_balanced():
    parens = to_balanced_parens(parse_newick("(((A,B),C),(D,(E,F)));"))
    depth = 0
    for c in parens:
        depth += 1 if c == "(" else -1
        assert depth >= 0
    assert depth == 0


# --- per-node agreement ----------------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        "(A,B);",
        "((A,B),(C,D));",
        "(((A,B),C),(D,(E,F)));",
        "((((A,B),C),D),E);",          # caterpillar
        "((A,B),(C,(D,(E,(F,G)))));",
    ],
)
def test_every_node_answers_the_same(tmp_path, text):
    arrays = parse_newick(text)
    columnar, succinct = both_stores(tmp_path, arrays)
    for i in range(arrays.n_nodes):
        assert succinct.subtree_end_of(i) == columnar.subtree_end_of(i), i
        assert succinct.leaf_count_of(i) == columnar.leaf_count_of(i), i
        assert succinct.is_leaf(i) == columnar.is_leaf(i), i
        assert succinct.label(i) == columnar.label(i), i
        assert succinct.parent_of(i) == columnar.parent_of(i), i


def test_the_root_has_no_parent(tmp_path):
    _, succinct = both_stores(tmp_path, parse_newick("((A,B),C);"))
    assert succinct.parent_of(0) == int(NO_PARENT)


def test_branch_lengths_survive(tmp_path):
    arrays = parse_newick("((A:1.5,B)x:2,C:3)root;")
    columnar, succinct = both_stores(tmp_path, arrays)
    for i in range(arrays.n_nodes):
        a, b = columnar.branch_len_of(i), succinct.branch_len_of(i)
        assert (np.isnan(a) and np.isnan(b)) or a == pytest.approx(b)


# --- the gate: identical slices --------------------------------------------

@pytest.mark.parametrize("budget", BUDGETS)
def test_slices_are_identical(tmp_path, budget):
    arrays = parse_newick("((((A,B),(C,D)),((E,F),(G,H))),((I,J),(K,L)));")
    columnar, succinct = both_stores(tmp_path, arrays)
    assert flatten(Summariser(columnar).summarise(0, budget)) == flatten(
        Summariser(succinct).summarise(0, budget)
    )


@pytest.mark.parametrize("budget", BUDGETS)
def test_slices_of_a_real_tree_are_identical(real_store, tmp_path, budget):
    columnar = read_tree(real_store / "trees" / "vibrio-upgma")
    write_succinct_tree(tmp_path / "s", columnar.to_arrays(), columnar.meta)
    succinct = read_succinct_tree(tmp_path / "s")
    assert flatten(Summariser(columnar).summarise(0, budget)) == flatten(
        Summariser(succinct).summarise(0, budget)
    )


def test_slicing_into_a_wedge_is_identical(real_store, tmp_path):
    """Navigation, not just the first view."""
    columnar = read_tree(real_store / "trees" / "vibrio-upgma")
    write_succinct_tree(tmp_path / "s", columnar.to_arrays(), columnar.meta)
    succinct = read_succinct_tree(tmp_path / "s")

    top = flatten(Summariser(columnar).summarise(0, 20))
    wedge = next(i for i, cut in zip(top["id"], top["truncated"]) if cut)
    assert flatten(Summariser(columnar).summarise(wedge, 50)) == flatten(
        Summariser(succinct).summarise(wedge, 50)
    )


def test_whole_columns_agree_when_materialised(tmp_path):
    """Used by full-tree folds; honest about reconstructing rather than holding."""
    arrays = parse_newick("(((A,B),C),(D,(E,F)));")
    columnar, succinct = both_stores(tmp_path, arrays)
    np.testing.assert_array_equal(succinct.subtree_end, np.asarray(columnar.subtree_end))
    np.testing.assert_array_equal(succinct.leaf_count, np.asarray(columnar.leaf_count))


# --- storage ---------------------------------------------------------------

def test_it_is_smaller_than_the_columnar_store(real_store, tmp_path):
    columnar = read_tree(real_store / "trees" / "vibrio-upgma")
    write_succinct_tree(tmp_path / "s", columnar.to_arrays(), columnar.meta)
    succinct = read_succinct_tree(tmp_path / "s")
    ratio = store_bytes(real_store / "trees" / "vibrio-upgma") / succinct.size_bytes()
    # ~2.2x with labels stored as strings; §12.3 records the full accounting.
    assert ratio > 2.0, f"only {ratio:.1f}x"


def test_format_version_mismatch_is_refused(tmp_path):
    import json

    arrays = parse_newick("((A,B),C);")
    both_stores(tmp_path, arrays)
    meta = tmp_path / "succinct" / "meta.json"
    raw = json.loads(meta.read_text())
    raw["format_version"] = 99
    meta.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="format 99"):
        read_succinct_tree(tmp_path / "succinct")


def test_it_says_so_when_the_extension_is_missing(tmp_path, monkeypatch):
    """The columnar store needs no compiler; this one does, and must say so."""
    from phylocmp.trees import succinct_store

    monkeypatch.setattr(succinct_store, "extension", lambda: None)
    with pytest.raises(NativeRequired, match="native/build.sh"):
        write_succinct_tree(tmp_path / "s", parse_newick("(A,B);"),
                            TreeMeta(id="t", species="s", method="upgma", source="",
                                     n_nodes=0, n_leaves=0, max_depth=0))
