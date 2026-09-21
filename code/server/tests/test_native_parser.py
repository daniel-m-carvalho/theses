"""The C++ parser, against the Python one it must agree with.

The Python parser stays the reference implementation: it produced the numbers
this project reports, and it is what runs where no compiler exists. The native
one is a speed choice, so the only thing worth testing is that it is not also a
behaviour change.

Every test here skips cleanly when the extension is not built — that is the
supported configuration, not a degraded one.
"""

from __future__ import annotations

import numpy as np
import pytest

from phylocmp.trees import native
from phylocmp.trees.newick import parse_newick, parse_newick_fast

pytestmark = pytest.mark.skipif(
    not native.available(),
    reason="native extension not built; run native/build.sh",
)

#: Cases chosen for the things that actually differ between implementations:
#: quoting, escapes, absent lengths, and whitespace — which TreeDiff's parser
#: mishandles silently.
CASES = [
    "A;",
    "(A,B);",
    "((A,B),(C,D));",
    "((A:1.5,B)x:2,C:3)root;",
    "('a,b':2,'c(d)')r;",
    "('O''Brien',B);",
    "((A,B)_:2,C)_;",
    "(A:0.0001,B:12345.678);",
    "(  A , B )  ;",
    "(\n  (A,B),\n  C\n);",
    "(((A,B),(C,D)),((E,F),(G,H)));",
]


def assert_same(text: str) -> None:
    expected = parse_newick(text)
    got = parse_newick_fast(text)
    assert got.labels == expected.labels
    for column in ("parent", "subtree_end", "depth", "leaf_count"):
        np.testing.assert_array_equal(
            np.asarray(getattr(got, column)),
            np.asarray(getattr(expected, column)),
            err_msg=f"{column} differs for {text!r}",
        )
    a = np.asarray(expected.branch_len)
    b = np.asarray(got.branch_len)
    np.testing.assert_array_equal(np.isnan(a), np.isnan(b))
    np.testing.assert_allclose(a[~np.isnan(a)], b[~np.isnan(b)], rtol=1e-6)


@pytest.mark.parametrize("text", CASES)
def test_agrees_with_the_python_parser(text):
    assert_same(text)


def test_whitespace_is_skipped():
    """TreeDiff emits a spurious leaf here; a pretty-printed file must not."""
    assert parse_newick_fast("(\n  (A, B),\n  C\n);").n_leaves == 3


def test_doubled_quotes_are_one_character():
    assert parse_newick_fast("('O''Brien',B);").labels[1] == "O'Brien"


def test_absent_lengths_are_nan_not_zero():
    got = parse_newick_fast("(A:1,B)r;")
    assert not np.isnan(got.branch_len[1])
    assert np.isnan(got.branch_len[2]), "no length is not the same as zero length"


@pytest.mark.parametrize("bad", ["(A,B));", "((A,B);", ""])
def test_malformed_input_raises(bad):
    with pytest.raises(ValueError):
        parse_newick_fast(bad)


def test_deep_tree_does_not_recurse():
    depth = 20_000
    text = "(" * depth + "L0" + "".join(f",L{i})" for i in range(1, depth + 1)) + ";"
    assert parse_newick_fast(text).n_leaves == depth + 1


def test_balanced_parentheses_are_emitted():
    """Two characters per node, which is what the succinct store will hold."""
    extension = native.extension()
    columns = extension.parse_newick("((A,B),C);")
    assert len(columns["balanced_parens"]) == 2 * len(columns["parent"])
    assert columns["balanced_parens"].count("(") == len(columns["parent"])


# --- the corpus: the gate --------------------------------------------------

@pytest.mark.parametrize(
    "filename,leaves",
    [
        ("vibrio-upgma-tree.nwk", 17_646),
        ("vibrio-nj-tree.nwk", 17_645),
        ("clostridium-upgma-tree.nwk", 27_962),
    ],
)
def test_real_trees_agree_and_have_the_expected_leaf_counts(datasets_dir, filename, leaves):
    text = (datasets_dir / "gen_trees" / filename).read_text()
    assert parse_newick_fast(text).n_leaves == leaves
    assert_same(text)


def test_it_is_actually_faster(datasets_dir):
    """Not a benchmark — a guard that the native path is being taken at all."""
    import time

    text = (datasets_dir / "gen_trees" / "vibrio-upgma-tree.nwk").read_text()
    started = time.perf_counter(); parse_newick(text)
    python_s = time.perf_counter() - started
    started = time.perf_counter(); parse_newick_fast(text)
    native_s = time.perf_counter() - started
    assert native_s < python_s, f"native {native_s:.3f}s vs python {python_s:.3f}s"
