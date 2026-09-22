"""Restrict two trees to the leaves they share.

Robinson-Foulds is defined only over a common leaf set: the algorithm builds a
bijection between the two trees' labels (paper S3.3), so a label present in one
tree and absent from the other has nothing to map to.

This is not a hypothetical. ``vibrio-nj-tree.nwk`` is missing ST 211, which the
UPGMA tree has, so the two differ by exactly one leaf out of 17,646. Handed the
files unreconciled, the reference implementation does not warn or skip -- it
dereferences past the end of its mapping and aborts:

    Assertion failed: (i > 0 and i <= m_arg_cnt), select_support_mcl.hpp:349

So reconciliation is explicit, and which leaves were dropped is reported rather
than silently absorbed. A comparison computed over a quietly different leaf set
is worse than one that fails.

Pruning can leave internal nodes with a single surviving child, so the result is
re-canonicalised (see ``normalise``) before it is used.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .newick import NO_PARENT, TreeArrays


@dataclass(frozen=True, slots=True)
class Reconciliation:
    """What restricting a pair to their shared leaves cost."""

    shared: int
    dropped_left: list[str]
    dropped_right: list[str]
    #: For each node of the reconciled tree, its index in the ORIGINAL stored
    #: tree. Comparison values are computed against the reconciled indexing and
    #: have to be placed back through this before they can be served.
    left_source_index: np.ndarray | None = None
    right_source_index: np.ndarray | None = None

    @property
    def is_identity(self) -> bool:
        return not self.dropped_left and not self.dropped_right


def leaf_labels(arrays: TreeArrays) -> list[str]:
    end = np.asarray(arrays.subtree_end)
    return [label for i, label in enumerate(arrays.labels) if end[i] == i + 1]


def restrict_to_leaves(arrays: TreeArrays, keep: set[str]) -> TreeArrays:
    """Keep only leaves in ``keep``. See ``restrict_to_leaves_with_map``."""
    result, _ = restrict_to_leaves_with_map(arrays, keep)
    return result


def restrict_to_leaves_with_map(
    arrays: TreeArrays, keep: set[str]
) -> tuple[TreeArrays, np.ndarray]:
    """Keep only leaves in ``keep``, and the internal nodes still above one.

    Re-indexing preserves pre-order, so subtrees stay contiguous and the
    interval encoding survives unchanged -- the same property that makes
    ``suppress_unary`` cheap.
    """
    n = arrays.n_nodes
    end = np.asarray(arrays.subtree_end)
    index = np.arange(n)
    is_leaf = end == index + 1

    survives = np.zeros(n, dtype=bool)
    for i in range(n):
        if is_leaf[i] and arrays.labels[i] in keep:
            survives[i] = True
    # An internal node survives iff a kept leaf lies in its interval. Reverse
    # order means the interval's contents are already decided.
    for i in range(n - 1, -1, -1):
        if not is_leaf[i]:
            survives[i] = bool(survives[i + 1 : int(end[i])].any())

    if survives.all():
        return arrays, index.astype(np.int64)

    parent = np.asarray(arrays.parent)
    surviving_parent = np.full(n, NO_PARENT, dtype=np.uint32)
    for i in range(n):
        p = parent[i]
        if p != NO_PARENT:
            surviving_parent[i] = p if survives[p] else surviving_parent[p]

    prefix = np.zeros(n + 1, dtype=np.uint32)
    np.cumsum(survives, dtype=np.uint32, out=prefix[1:])
    kept = np.flatnonzero(survives)
    m = len(kept)
    if m == 0:
        raise ValueError("restriction removed every node")

    new_parent = np.empty(m, dtype=np.uint32)
    sp = surviving_parent[kept]
    has_parent = sp != NO_PARENT
    new_parent[~has_parent] = NO_PARENT
    new_parent[has_parent] = prefix[sp[has_parent].astype(np.int64)]

    new_end = prefix[end[kept].astype(np.int64)].astype(np.uint32)

    new_depth = np.zeros(m, dtype=np.uint16)
    for i in range(1, m):
        new_depth[i] = new_depth[new_parent[i]] + 1

    new_leaf_count = np.zeros(m, dtype=np.uint32)
    for i in range(m - 1, -1, -1):
        if new_end[i] == i + 1:
            new_leaf_count[i] = 1
        p = new_parent[i]
        if p != NO_PARENT:
            new_leaf_count[p] += new_leaf_count[i]

    return TreeArrays(
        parent=new_parent,
        subtree_end=new_end,
        depth=new_depth,
        leaf_count=new_leaf_count,
        branch_len=np.asarray(arrays.branch_len)[kept].astype(np.float32),
        labels=[arrays.labels[i] for i in kept],
    ), kept.astype(np.int64)


def reconcile(
    left: TreeArrays, right: TreeArrays
) -> tuple[TreeArrays, TreeArrays, Reconciliation]:
    """Restrict both trees to their shared leaf labels and re-canonicalise."""
    from .normalise import assert_rooted_binary, suppress_unary_with_map

    left_labels = set(leaf_labels(left))
    right_labels = set(leaf_labels(right))
    shared = left_labels & right_labels
    if not shared:
        raise ValueError(
            "the two trees share no leaf labels; they are not comparable "
            "(different species use the same ST numbers for different organisms)"
        )

    out, maps = [], []
    for arrays in (left, right):
        restricted, kept = restrict_to_leaves_with_map(arrays, shared)
        restricted, _, kept2 = suppress_unary_with_map(restricted)
        assert_rooted_binary(restricted)
        out.append(restricted)
        maps.append(kept[kept2])  # compose: reconciled index -> original index

    report = Reconciliation(
        shared=len(shared),
        dropped_left=sorted(left_labels - shared),
        dropped_right=sorted(right_labels - shared),
        left_source_index=maps[0],
        right_source_index=maps[1],
    )
    return out[0], out[1], report
