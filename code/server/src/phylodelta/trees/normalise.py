"""Canonicalise a parsed tree before it enters the store.

The store's contract is a **rooted binary tree**: ``n_nodes == 2 * n_leaves - 1``,
every internal node with exactly two children. The rest of the backend leans on
that. Real files do not always arrive that way, so they are normalised once at
ingest rather than defended against on every request.

Found in the data, not anticipated: ``vibrio-nj-tree.nwk`` is written as ``(X);``
-- a root with a single child. A unary node is not harmless.

* It **duplicates a bipartition.** A node's cluster is the leaf set beneath it;
  a unary node's cluster is identical to its only child's. Robinson-Foulds is
  defined over the *set* of bipartitions, so a duplicate either inflates a
  naive count or silently collapses, depending on the implementation -- exactly
  the kind of off-by-one that makes two RF implementations disagree.
* It **wastes a slice entry**, and shows the user a branch point that is not one.

Suppression is the standard fix and is topology-preserving: the node is removed
and its branch length is added to its child's, so root-to-leaf distances are
unchanged. Chains of unary nodes collapse in one pass.

This is recorded in ``meta.json`` as ``suppressed_unary``, because it means the
stored node indices are *our canonical form* and not offsets into the source
file. Since node identity is defined as the pre-order index in this store, that
is the intended reading -- but it has to be stated, not assumed.
"""

from __future__ import annotations

import numpy as np

from .newick import NO_PARENT, TreeArrays


def child_counts(arrays: TreeArrays) -> np.ndarray:
    counts = np.zeros(arrays.n_nodes, dtype=np.int64)
    parent = np.asarray(arrays.parent)
    has_parent = parent != NO_PARENT
    np.add.at(counts, parent[has_parent].astype(np.int64), 1)
    return counts


def suppress_unary(arrays: TreeArrays) -> tuple[TreeArrays, int]:
    """Remove internal nodes with exactly one child. Returns the new tree and a count."""
    result, removed, _ = suppress_unary_with_map(arrays)
    return result, removed


def suppress_unary_with_map(arrays: TreeArrays) -> tuple[TreeArrays, int, np.ndarray]:
    """As ``suppress_unary``, and also the source index of each surviving node.

    The mapping matters because anything computed on the canonicalised tree --
    a comparison, for instance -- is indexed by the NEW pre-order positions, and
    has to be placed back onto the original tree before it can be served under
    the original tree's node ids.
    """
    n = arrays.n_nodes
    index = np.arange(n, dtype=np.uint32)
    is_leaf = np.asarray(arrays.subtree_end) == index + 1
    counts = child_counts(arrays)

    keep = is_leaf | (counts != 1)
    removed = int(n - keep.sum())
    if removed == 0:
        return arrays, 0, index.astype(np.int64)

    parent = np.asarray(arrays.parent)
    branch = np.asarray(arrays.branch_len, dtype=np.float64)

    # Forward passes: a parent always precedes its children in pre-order, so one
    # sweep resolves both the nearest surviving ancestor and the branch length
    # accumulated across a chain of suppressed nodes.
    surviving_parent = np.full(n, NO_PARENT, dtype=np.uint32)
    carried = np.zeros(n, dtype=np.float64)  # length owed to a node by dead ancestors
    for i in range(n):
        p = parent[i]
        if p == NO_PARENT:
            continue
        if keep[p]:
            surviving_parent[i] = p
            carried[i] = 0.0
        else:
            surviving_parent[i] = surviving_parent[p]
            dead_len = branch[p]
            carried[i] = carried[p] + (0.0 if np.isnan(dead_len) else dead_len)

    # A suppressed node's length passes to its child. NaN means "no length
    # given": a tree with no lengths at all must not acquire them, so NaN with
    # nothing carried stays NaN. If a dead ancestor did carry a length, that
    # distance is real and is kept rather than discarded.
    new_branch = np.where(
        np.isnan(branch),
        np.where(carried == 0.0, np.nan, carried),
        branch + carried,
    )

    # Re-index. Removal preserves pre-order, so the new index of a kept node is
    # simply how many kept nodes precede it -- and a subtree stays contiguous,
    # which is what lets the interval encoding survive the rewrite.
    prefix = np.zeros(n + 1, dtype=np.uint32)
    np.cumsum(keep, dtype=np.uint32, out=prefix[1:])
    kept_idx = np.flatnonzero(keep)

    new_n = len(kept_idx)
    new_parent = np.empty(new_n, dtype=np.uint32)
    survivors = surviving_parent[kept_idx]
    has_parent = survivors != NO_PARENT
    new_parent[~has_parent] = NO_PARENT
    new_parent[has_parent] = prefix[survivors[has_parent].astype(np.int64)]

    new_end = prefix[np.asarray(arrays.subtree_end)[kept_idx].astype(np.int64)]

    new_depth = np.zeros(new_n, dtype=np.uint16)
    for i in range(1, new_n):
        new_depth[i] = new_depth[new_parent[i]] + 1

    result = TreeArrays(
        parent=new_parent,
        subtree_end=new_end.astype(np.uint32),
        depth=new_depth,
        leaf_count=np.asarray(arrays.leaf_count)[kept_idx].astype(np.uint32),
        branch_len=new_branch[kept_idx].astype(np.float32),
        labels=[arrays.labels[i] for i in kept_idx],
    )
    return result, removed, kept_idx.astype(np.int64)


def assert_rooted_binary(arrays: TreeArrays) -> None:
    """The invariant the store promises its readers."""
    counts = child_counts(arrays)
    index = np.arange(arrays.n_nodes, dtype=np.uint32)
    internal = np.asarray(arrays.subtree_end) != index + 1
    bad = np.flatnonzero(internal & (counts != 2))
    if bad.size:
        raise ValueError(
            f"{bad.size} internal node(s) are not binary, first at pre-order index "
            f"{int(bad[0])} with {int(counts[bad[0]])} child(ren)"
        )
    if arrays.n_nodes != 2 * arrays.n_leaves - 1:
        raise ValueError(
            f"{arrays.n_nodes} nodes for {arrays.n_leaves} leaves; "
            f"a rooted binary tree has {2 * arrays.n_leaves - 1}"
        )
