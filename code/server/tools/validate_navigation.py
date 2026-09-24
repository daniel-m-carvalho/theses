"""Exhaustive navigation + cross-tree jump validation.

Calls the real route functions, so what is checked is what ships.
"""
import sys
from collections import Counter
from pathlib import Path

import numpy as np

from phylodelta import config
from phylodelta.api.routes_trees import tree_ancestor, tree_slice
from phylodelta.metrics.contract import NO_CORRESPONDENCE
from phylodelta.metrics.store import CorrespondenceReader
from phylodelta.trees.store import read_tree

OWNER = "local"
MIN_LEAVES = 20
BUDGET = 60
fails: list[str] = []


def bad(msg):
    fails.append(msg)
    if len(fails) <= 20:
        print("  FAIL", msg)


def slice_of(tree_id, root, budget, compare=None, keep=None):
    return tree_slice(tree_id=tree_id, root=root, budget=budget, compare=compare,
                      metric="rf", order="size", keep=keep, owner=OWNER)


def walk(tree_id, arrays, budget=500):
    """Expand every wedge, from the root, until the whole tree has been seen."""
    seen_leaves = Counter()
    slices = 0
    stack = [0]
    while stack:
        root = stack.pop()
        body = slice_of(tree_id, root, budget)
        slices += 1
        n = body.nodes
        ids, cut, truth = n.id, n.truncated, n.true_leaf_count

        if ids[0] != root:
            bad(f"{tree_id}: slice at {root} is rooted at {ids[0]}")
        if n.parent[0] != -1:
            bad(f"{tree_id}: slice at {root} has a parent for its own root")
        lengths = {len(v) for v in (ids, cut, truth, n.parent, n.label, n.branch_len)}
        if len(lengths) != 1:
            bad(f"{tree_id}: slice at {root} arrays disagree: {lengths}")

        displayed_wedges = sum(cut)
        if body.hidden_leaves + (body.displayed_leaves - displayed_wedges) != body.total_leaves:
            bad(f"{tree_id}: slice at {root} loses leaves")

        for k, node_id in enumerate(ids):
            if not 0 <= node_id < arrays.n_nodes:
                bad(f"{tree_id}: node {node_id} out of range")
                continue
            # A node in a slice rooted at `root` must lie inside its interval.
            if not (root <= node_id < arrays.subtree_end[root]):
                bad(f"{tree_id}: slice at {root} returned {node_id}, outside it")
            if cut[k]:
                if int(arrays.leaf_count[node_id]) <= 1:
                    bad(f"{tree_id}: wedge {node_id} hides nothing")
                stack.append(int(node_id))
            elif int(arrays.leaf_count[node_id]) == 1:
                seen_leaves[int(node_id)] += 1

    return seen_leaves, slices


def check_tree(tree_id):
    arrays = read_tree(Path(config.STORE_DIR) / "trees" / tree_id).to_arrays()
    print(f"\n== navigating {tree_id} ({arrays.n_leaves:,} leaves, {arrays.n_nodes:,} nodes)")
    seen, slices = walk(tree_id, arrays)
    expected = {i for i in range(arrays.n_nodes) if int(arrays.leaf_count[i]) == 1}
    repeats = [i for i, c in seen.items() if c > 1]
    missing = expected - set(seen)
    extra = set(seen) - expected
    print(f"   {slices:,} slices, {len(seen):,} distinct leaves drawn")
    if missing:
        bad(f"{tree_id}: {len(missing):,} leaves never reachable, e.g. {sorted(missing)[:5]}")
    if extra:
        bad(f"{tree_id}: drew {len(extra):,} non-leaves as leaves")
    if repeats:
        bad(f"{tree_id}: {len(repeats):,} leaves drawn more than once")
    return arrays


def check_jumps(pair_id, left_id, right_id, L, R, shared):
    corr = CorrespondenceReader(Path(config.STORE_DIR) / "pairs" / pair_id / "correspondence")
    for side, src_id, src, dst_id, dst in (("left", left_id, L, right_id, R),
                                           ("right", right_id, R, left_id, L)):
        cor = np.asarray(corr.column(side, "corresponds"))
        leaves = [i for i in range(src.n_nodes) if int(src.leaf_count[i]) == 1]
        print(f"\n== {pair_id}: jumping all {len(leaves):,} leaves of {src_id} -> {dst_id}")
        unmatched = mislabelled = widened = invisible = 0
        sizes = []
        for leaf in leaves:
            target = int(cor[leaf])
            # The column is UNSIGNED: "no counterpart" is 0xFFFFFFFF, not -1.
            # The API translates it to null before it reaches a client (and the
            # client skips nulls, so the menu item is correctly disabled), but
            # reading the store directly means doing that translation here.
            if target == int(NO_CORRESPONDENCE):
                unmatched += 1
                continue
            if not 0 <= target < dst.n_nodes:
                bad(f"{src_id} leaf {leaf}: target {target} outside {dst_id}")
                continue
            if src.labels[leaf] != dst.labels[target]:
                mislabelled += 1
                bad(f"{src_id} leaf {leaf} {src.labels[leaf]!r} -> "
                    f"{dst_id} {target} {dst.labels[target]!r}: labels differ")
            got = tree_ancestor(tree_id=dst_id, node=target,
                                min_leaves=MIN_LEAVES, owner=OWNER)
            anc = got.node
            if not (anc <= target < dst.subtree_end[anc]):
                bad(f"{dst_id}: {anc} is not an ancestor of {target}")
            if got.leaves != int(dst.leaf_count[anc]):
                bad(f"{dst_id}: ancestor {anc} reported {got.leaves} leaves, "
                    f"tree says {int(dst.leaf_count[anc])}")
            # `> 1` was too weak a check and let the actual complaint through:
            # a two-leaf clade is two dots and a line, which says the leaf
            # exists and nothing about where it sits. The floor is the promise.
            if got.leaves < MIN_LEAVES and not got.reached_root:
                bad(f"{dst_id}: jump from {src_id} leaf {leaf} lands on "
                    f"{got.leaves} leaves, under the {MIN_LEAVES}-leaf floor")
            if anc != target:
                widened += 1
            sizes.append(got.leaves)

            # The point of the whole exercise: after widening, is the leaf the
            # user asked for actually on screen, drawn as itself?
            body = slice_of(dst_id, anc, BUDGET, keep=target)
            ids, cut = body.nodes.id, body.nodes.truncated
            if target not in ids:
                invisible += 1
                bad(f"{dst_id}: jump from {src_id} leaf {leaf} -> {target} "
                    f"rooted at {anc} ({got.leaves} leaves) does not draw it")
            elif cut[ids.index(target)]:
                invisible += 1
                bad(f"{dst_id}: jump from {src_id} leaf {leaf} -> {target} "
                    f"is drawn as a wedge")
            wedges = sum(cut)
            if body.hidden_leaves + (body.displayed_leaves - wedges) != body.total_leaves:
                bad(f"{dst_id}: slice at {anc} with keep={target} loses leaves")
            if body.displayed_leaves > BUDGET:
                bad(f"{dst_id}: slice at {anc} with keep={target} drew "
                    f"{body.displayed_leaves} tips over a budget of {BUDGET}")
        sizes = np.array(sizes)
        # Every unmatched leaf must be one reconciliation dropped; anything
        # else is a leaf silently losing its counterpart.
        dropped = int(src.n_leaves) - int(shared)
        if unmatched != dropped:
            bad(f"{src_id}: {unmatched:,} leaves without a counterpart, but "
                f"reconciliation dropped {dropped:,}")
        print(f"   matched {len(sizes):,}  unmatched {unmatched:,} "
              f"(reconciliation dropped {dropped:,})  mislabelled {mislabelled:,}")
        print(f"   widened {widened:,}/{len(sizes):,}; target subtree leaves: "
              f"min {sizes.min()} median {int(np.median(sizes))} max {sizes.max()}; "
              f"under the {MIN_LEAVES}-leaf floor: {(sizes < MIN_LEAVES).sum():,}")
        print(f"   target leaf not drawn after widening: {invisible:,}")


if __name__ == "__main__":
    pair_id, left_id, right_id = sys.argv[1], sys.argv[2], sys.argv[3]
    L = check_tree(left_id)
    R = check_tree(right_id)
    import json
    meta = json.loads(
        (Path(config.STORE_DIR) / "pairs" / pair_id / "rf" / "meta.json").read_text()
    )
    shared = int(meta["summary"]["n_leaves"])
    print(f"\nreconciliation: {shared:,} shared leaves "
          f"({left_id} has {L.n_leaves:,}, {right_id} has {R.n_leaves:,})")
    check_jumps(pair_id, left_id, right_id, L, R, shared)
    print(f"\n{'PASS' if not fails else f'{len(fails):,} FAILURES'}")
    sys.exit(1 if fails else 0)
