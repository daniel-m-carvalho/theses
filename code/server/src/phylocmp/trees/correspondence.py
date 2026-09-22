"""Clade correspondence between two reconciled trees.

Answers two questions that every comparison view needs and **no metric owns**:
*how much of this clade survives in the other tree*, and *which clade is it*.
Both are set operations over two topologies — Jaccard overlap of leaf sets, and
the clade achieving it. Nothing about them is Robinson-Foulds, or triplet, or
geodesic.

They used to live inside the RF plugin, because RF's own test falls out of the
same traversal: writing ``a`` for a clade's size and ``b`` for its container's,
RF asks ``a == b`` while Jaccard against that container is ``a / b``. That is an
accident of RF, not a property of comparison, and it had two costs. A second
metric would have had to reimplement the search, in its own language; and a
metric with no per-clade notion at all — a geodesic distance is a single number
over branch lengths — could not be stored, because the contract demanded
per-node values it has no way to produce.

So correspondence is computed **once per pair**, before any metric runs, and
every metric shares it. A metric that declares nothing of its own still gets a
full visual comparison; a metric with more to say adds its own columns beside
these.

Provenance
----------
The measure is **adopted from Phylo.io** (`phylo-io/src/worker_bcn.js`): score a
clade by the maximum Jaccard overlap of its leaf set against clades of the other
tree, and colour by that. What differs here is exactness and placement — Phylo.io
retrieves ten candidates with MinHash/LSH in the browser while the user waits;
this evaluates every clade, once, offline. See DECISIONS.md, *References and
provenance*.

Cost, measured: the best-match search is **12.6 s of the 13 s** a pair takes,
which is why it is the first thing the native core should claim.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .newick import NO_PARENT, TreeArrays

#: No counterpart in the other tree. u32 max, so the column stays unsigned.
NO_CORRESPONDENCE = np.uint32(0xFFFFFFFF)


@dataclass(frozen=True, slots=True)
class CorrespondenceSide:
    """Per-node correspondence for one side, indexed by pre-order position."""

    #: Overlap with the best corresponding clade in the other tree, in [0, 1].
    similarity: np.ndarray  # f32
    #: Pre-order index of that clade in the OTHER tree.
    corresponds: np.ndarray  # u32

    def __post_init__(self) -> None:
        if self.similarity.shape[0] != self.corresponds.shape[0]:
            raise ValueError("correspondence arrays must be the same length")


@dataclass(frozen=True, slots=True)
class Correspondence:
    """What both trees say about each other, plus the leaf maps metrics reuse."""

    left: CorrespondenceSide
    right: CorrespondenceSide
    #: For each node of the left tree, its leaf position in the right tree
    #: (-1 at internal nodes). Metrics needing the bijection reuse these rather
    #: than rebuilding them.
    left_to_right: np.ndarray
    right_to_left: np.ndarray


def _leaf_index(arrays: TreeArrays) -> tuple[np.ndarray, np.ndarray]:
    """Number the leaves 0..L-1 in pre-order.

    Returns ``(position_of_node, node_of_position)``. ``position_of_node`` is -1
    at internal nodes. Because a subtree is a contiguous pre-order range, the
    leaves of any clade are contiguous in this numbering too -- the property
    Day's algorithm turns into an O(1) membership test.
    """
    n = arrays.n_nodes
    end = np.asarray(arrays.subtree_end)
    is_leaf = end == np.arange(n) + 1
    node_of_position = np.flatnonzero(is_leaf).astype(np.uint32)
    position_of_node = np.full(n, -1, dtype=np.int64)
    position_of_node[node_of_position] = np.arange(len(node_of_position))
    return position_of_node, node_of_position


def _aggregate(arrays: TreeArrays, leaf_value: np.ndarray) -> tuple[np.ndarray, ...]:
    """Fold ``leaf_value`` up the tree: per node, the min, max and count.

    One reverse pass: a node's children all follow it in pre-order, so by the
    time the loop reaches a node its children have already contributed.
    """
    n = arrays.n_nodes
    parent = np.asarray(arrays.parent)
    end = np.asarray(arrays.subtree_end)
    is_leaf = end == np.arange(n) + 1

    lo = np.full(n, np.iinfo(np.int64).max, dtype=np.int64)
    hi = np.full(n, -1, dtype=np.int64)
    count = np.zeros(n, dtype=np.int64)

    lo[is_leaf] = leaf_value[is_leaf]
    hi[is_leaf] = leaf_value[is_leaf]
    count[is_leaf] = 1

    for i in range(n - 1, 0, -1):
        p = int(parent[i])
        if p == NO_PARENT:
            continue
        if lo[i] < lo[p]:
            lo[p] = lo[i]
        if hi[i] > hi[p]:
            hi[p] = hi[i]
        count[p] += count[i]
    return lo, hi, count


class _Lca:
    """Binary lifting: O(n log n) to build, O(log n) per query."""

    def __init__(self, arrays: TreeArrays) -> None:
        n = arrays.n_nodes
        parent = np.asarray(arrays.parent).astype(np.int64).copy()
        parent[parent == NO_PARENT] = 0  # the root is its own ancestor
        self.depth = np.asarray(arrays.depth).astype(np.int64)
        self.levels = max(1, int(np.ceil(np.log2(max(n, 2)))) + 1)
        self.up = np.empty((self.levels, n), dtype=np.int64)
        self.up[0] = parent
        for k in range(1, self.levels):
            self.up[k] = self.up[k - 1][self.up[k - 1]]

    def query(self, u: np.ndarray, v: np.ndarray) -> np.ndarray:
        """Vectorised LCA of two equal-length arrays of node indices."""
        u = u.astype(np.int64).copy()
        v = v.astype(np.int64).copy()
        du, dv = self.depth[u], self.depth[v]
        # Make u the deeper of the two, then lift it level with v.
        swap = dv > du
        u[swap], v[swap] = v[swap].copy(), u[swap].copy()
        diff = self.depth[u] - self.depth[v]
        for k in range(self.levels):
            take = (diff >> k) & 1 == 1
            if take.any():
                u[take] = self.up[k][u[take]]
        # Lift both together while their ancestors differ.
        for k in range(self.levels - 1, -1, -1):
            differ = self.up[k][u] != self.up[k][v]
            if differ.any():
                u[differ] = self.up[k][u[differ]]
                v[differ] = self.up[k][v[differ]]
        return np.where(u == v, u, self.up[0][u])


def _best_matches(
    source: TreeArrays,
    target: TreeArrays,
    source_to_target_position: np.ndarray,
    count: np.ndarray,
    lca: np.ndarray,
    similarity: np.ndarray,
    corresponds: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Replace the LCA estimate with the true best-overlapping target clade.

    For a source clade A and a target clade C, ``|A n C|`` is the number of A's
    taxa whose target position falls in C's contiguous leaf range -- two binary
    searches. Evaluating every C at once with numpy makes this O(n log a) per
    clade rather than the O(n * a) a naive intersection would cost.
    """
    n = source.n_nodes
    end = np.asarray(source.subtree_end)
    index = np.arange(n)
    is_leaf = end == index + 1

    # Target clades as half-open ranges over target leaf positions.
    t_position_of_node, _ = _leaf_index(target)
    t_lo, t_hi, _ = _aggregate(target, t_position_of_node)
    t_size = np.asarray(target.leaf_count).astype(np.int64)

    # A source clade's taxa are contiguous in SOURCE leaf order, so its target
    # positions are one slice of this array -- no per-clade gather needed.
    source_leaf_positions = source_to_target_position[is_leaf]
    s_position_of_node, _ = _leaf_index(source)
    s_lo, _, _ = _aggregate(source, s_position_of_node)

    similarity = np.ascontiguousarray(similarity, dtype=np.float32)
    corresponds = np.ascontiguousarray(corresponds, dtype=np.uint32)

    from .. import config
    from . import native

    extension = native.extension()
    if extension is not None:
        # Same search, same result — the native version prunes candidates that
        # provably cannot win rather than scoring every clade, and is checked
        # against this loop for exact equality.
        return extension.best_matches(
            source_leaf_positions=np.ascontiguousarray(source_leaf_positions, dtype=np.int64),
            source_leaf_start=np.ascontiguousarray(s_lo, dtype=np.int64),
            source_size=np.ascontiguousarray(count, dtype=np.int64),
            source_is_leaf=np.ascontiguousarray(is_leaf, dtype=np.uint8),
            lca=np.ascontiguousarray(lca, dtype=np.int64),
            target_lo=np.ascontiguousarray(t_lo, dtype=np.int64),
            target_hi=np.ascontiguousarray(t_hi, dtype=np.int64),
            target_size=np.ascontiguousarray(t_size, dtype=np.int64),
            seed_similarity=similarity,
            seed_corresponds=corresponds,
            threads=config.threads(),
        )

    similarity = similarity.copy()
    corresponds = corresponds.copy()

    for i in np.flatnonzero(~is_leaf):
        a = int(count[i])
        taxa = np.sort(source_leaf_positions[int(s_lo[i]) : int(s_lo[i]) + a])
        overlap = np.searchsorted(taxa, t_hi + 1) - np.searchsorted(taxa, t_lo)
        union = a + t_size - overlap
        jaccard = overlap / union
        best = int(np.argmax(jaccard))
        similarity[i] = np.float32(jaccard[best])
        corresponds[i] = np.uint32(best)
    return similarity, corresponds


def _side(
    source: TreeArrays,
    target: TreeArrays,
    source_to_target_position: np.ndarray,
    target_lca: "_Lca",
    target_leaf_node: np.ndarray,
    best_match: bool,
) -> CorrespondenceSide:
    """Correspondence for every node of ``source``, against ``target``."""
    n = source.n_nodes
    end = np.asarray(source.subtree_end)
    is_leaf = end == np.arange(n) + 1
    internal = ~is_leaf

    lo, hi, count = _aggregate(source, source_to_target_position)
    target_leaf_count = np.asarray(target.leaf_count).astype(np.int64)

    # The smallest target clade containing all of this clade's taxa is the LCA
    # of its extremes: target clades are contiguous in target leaf order, so the
    # extremes bracket the whole set.
    lca = np.zeros(n, dtype=np.int64)
    lca[is_leaf] = target_leaf_node[source_to_target_position[is_leaf]]
    if internal.any():
        lca[internal] = target_lca.query(
            target_leaf_node[lo[internal]], target_leaf_node[hi[internal]]
        )

    similarity = (count / target_leaf_count[lca]).astype(np.float32)
    corresponds = lca.astype(np.uint32)

    if best_match:
        similarity, corresponds = _best_matches(
            source, target, source_to_target_position, count, lca, similarity, corresponds
        )
    return CorrespondenceSide(similarity=similarity, corresponds=corresponds)


def leaf_position_maps(
    left: TreeArrays, right: TreeArrays
) -> tuple[np.ndarray, np.ndarray]:
    """Map each tree's leaves onto the other's leaf numbering.

    Validates the bijection a clade comparison depends on. These checks used to
    sit inside the RF plugin; every clade-based metric needs them, and a metric
    that skipped them would produce a confident wrong answer rather than fail.
    """
    _, l_leaf_node = _leaf_index(left)
    _, r_leaf_node = _leaf_index(right)

    right_position_of_label = {
        right.labels[int(node)]: position for position, node in enumerate(r_leaf_node)
    }
    left_position_of_label = {
        left.labels[int(node)]: position for position, node in enumerate(l_leaf_node)
    }
    if len(right_position_of_label) != right.n_leaves:
        raise ValueError("right tree has duplicate leaf labels; a bijection is required")
    if len(left_position_of_label) != left.n_leaves:
        raise ValueError("left tree has duplicate leaf labels; a bijection is required")
    if set(left_position_of_label) != set(right_position_of_label):
        raise ValueError(
            "the two trees do not have the same leaf set; reconcile them first "
            "(trees.reconcile.reconcile)"
        )

    left_to_right = np.full(left.n_nodes, -1, dtype=np.int64)
    for node in l_leaf_node:
        left_to_right[int(node)] = right_position_of_label[left.labels[int(node)]]
    right_to_left = np.full(right.n_nodes, -1, dtype=np.int64)
    for node in r_leaf_node:
        right_to_left[int(node)] = left_position_of_label[right.labels[int(node)]]
    return left_to_right, right_to_left


def compute_correspondence(
    left: TreeArrays, right: TreeArrays, best_match: bool = True
) -> Correspondence:
    """Correspondence for a reconciled pair, both directions.

    ``best_match=False`` falls back to the free LCA ratio, which is a **lower
    bound** on similarity, not an approximation of it. It is retained because
    the two were compared on real data — the cheap estimate reports below 0.1
    on 653 clades whose true best match exceeds 0.5 — and that measurement is
    worth being able to reproduce. It is not a supported serving mode.
    """
    left_to_right, right_to_left = leaf_position_maps(left, right)
    _, l_leaf_node = _leaf_index(left)
    _, r_leaf_node = _leaf_index(right)
    left_lca, right_lca = _Lca(left), _Lca(right)

    return Correspondence(
        left=_side(left, right, left_to_right, right_lca, r_leaf_node, best_match),
        right=_side(right, left, right_to_left, left_lca, l_leaf_node, best_match),
        left_to_right=left_to_right,
        right_to_left=right_to_left,
    )
