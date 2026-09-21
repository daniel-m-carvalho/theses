"""Robinson-Foulds distance.

Only the distance. Clade correspondence — the Jaccard gradient and the best
corresponding node — lives in ``trees.correspondence`` and is computed once per
pair for every metric to share. This file is what remains when that is taken
out, and it is a good deal less than it used to be: of ~275 lines, ~180 were
general machinery and ~95 were actually Robinson-Foulds.

The verdict is derived, not recomputed
--------------------------------------
A clade is present in the other tree iff the clade best matching it has
**exactly** the same leaf set — which is ``similarity == 1.0``. Jaccard is 1
only when intersection equals union, and that is set equality. So RF's
per-clade ``exact`` column falls out of correspondence with no second traversal,
and a native implementation of this metric needs to return only a number.

That equivalence is asserted, not assumed: ``test_similarity_never_contradicts_
the_exact_verdict`` checks it holds on every one of the 35,289 and 35,291 nodes
of the real pair.

Cross-checked against a second mechanism
----------------------------------------
The shared-clade count is also computed by Day's interval test, which decides
membership with no LCA and no best-match search at all, and the two must agree.
Three of the five RF implementations examined for this project return wrong
answers on real input, all of them silently, so an assertion between two
mechanisms sharing no machinery is cheap insurance against joining them.
"""

from __future__ import annotations

import numpy as np

from ....trees.correspondence import Correspondence, _aggregate, _leaf_index
from ....trees.newick import TreeArrays
from ...contract import MetricResult, MetricSide


def _internal_mask(arrays: TreeArrays) -> np.ndarray:
    end = np.asarray(arrays.subtree_end)
    return end != np.arange(arrays.n_nodes) + 1


def _shared_by_day(
    left: TreeArrays, right: TreeArrays, left_to_right_position: np.ndarray
) -> int:
    """Count shared clades by Day's interval test, using no correspondence at all.

    A left clade is a right clade iff its taxa occupy a *contiguous* run of the
    right tree's leaf order AND that exact run is one of the right tree's
    clades. Independent of the best-match machinery, so it is a genuine
    cross-check rather than a restatement.
    """
    lo, hi, count = _aggregate(left, left_to_right_position)
    left_internal = _internal_mask(left)

    r_position_of_node, _ = _leaf_index(right)
    r_lo, r_hi, _ = _aggregate(right, r_position_of_node)
    right_internal = _internal_mask(right)

    stride = right.n_leaves + 1
    right_codes = np.unique(r_lo[right_internal] * stride + r_hi[right_internal])

    contiguous = left_internal & (hi - lo + 1 == count)
    codes = lo[contiguous] * stride + hi[contiguous]
    return int(np.isin(codes, right_codes).sum())


def compute(
    left: TreeArrays, right: TreeArrays, correspondence: Correspondence
) -> MetricResult:
    """Robinson-Foulds distance, and the per-clade exact-match verdict."""
    left_internal = _internal_mask(left)
    right_internal = _internal_mask(right)

    left_exact = np.isclose(correspondence.left.similarity, 1.0)
    right_exact = np.isclose(correspondence.right.similarity, 1.0)

    shared_left = int(left_exact[left_internal].sum())
    shared_right = int(right_exact[right_internal].sum())
    if shared_left != shared_right:
        raise AssertionError(
            f"clade sharing is not symmetric: {shared_left} vs {shared_right}"
        )

    by_day = _shared_by_day(left, right, correspondence.left_to_right)
    if by_day != shared_left:
        raise AssertionError(
            f"correspondence and Day's interval test disagree: {shared_left} vs {by_day}"
        )

    internal_left = left.n_leaves - 1
    internal_right = right.n_leaves - 1
    # The paper's Algorithm 2: internal-node counts stand in for the number of
    # non-singleton clades (valid only because unary nodes were suppressed,
    # §1.4/§2.4), and the result is halved, as most implementations do.
    rf = (internal_left + internal_right - 2 * shared_left) / 2

    return MetricResult(
        name="rf",
        summary={
            "rf": rf,
            "rf_normalised": rf / max(internal_left + internal_right - 2, 1),
            "shared_clusters": shared_left,
            "clusters_left": internal_left,
            "clusters_right": internal_right,
            "n_leaves": left.n_leaves,
        },
        left=MetricSide(columns={"exact": left_exact}),
        right=MetricSide(columns={"exact": right_exact}),
    )
