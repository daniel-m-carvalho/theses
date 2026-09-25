"""Build a ladder of comparison PAIRS at controlled sizes, from one real pair.

The benchmark needs the same two trees at many sizes. Both halves come from the
**real vibrio pair** rather than from a random generator, because the cost of
everything measured here depends on tree *shape*: these trees are deep and
unbalanced (max depth 604), and a randomly balanced tree of the same leaf count
is a different and much easier problem (§15.1, §17.1).

Down from the original, leaves are **pruned** — a subsample of the shared taxa,
applied identically to both trees, so every rung is still a genuine pair with a
shared leaf set and a real topology.

Up from it, relabelled copies are **nested**: `(original, (copy1, copy2))`,
which preserves depth and imbalance instead of flattening them the way joining
N copies under one root would. This is the construction §17.1's scaling table
used, kept here so the benchmark and that table are talking about the same
trees.

    uv run python tools/make_ladder.py <out-dir>
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

import numpy as np

from phylodelta.trees.newick import parse_newick_file
from phylodelta.trees.newick_writer import to_newick

REPO = Path(__file__).resolve().parents[3]
LEFT = REPO / "datasets" / "gen_trees" / "vibrio-nj-tree.nwk"
RIGHT = REPO / "datasets" / "gen_trees" / "vibrio-upgma-tree.nwk"

#: Leaf counts to build. Below the original by pruning, above it by nesting.
#: Chosen to double, so a cost curve has enough points to show its shape, and
#: to bracket the sizes phylo.io is documented to handle.
RUNGS = [1_000, 2_500, 5_000, 10_000, 17_645, 35_290, 70_580, 141_160, 282_320]


def leaves_of(arrays) -> list[str]:
    end = np.asarray(arrays.subtree_end)
    return [
        arrays.labels[i] for i in range(arrays.n_nodes) if int(end[i]) == i + 1
    ]


def prune(text: str, keep: set[str]) -> str:
    """Keep only `keep`, by rebuilding the Newick string from the kept leaves.

    Done textually on a re-parse rather than with the store's machinery: the
    ladder is input *to* the benchmark, so it must not depend on the code under
    measurement to exist.
    """
    from phylodelta.trees.newick import parse_newick

    arrays = parse_newick(text)
    end = np.asarray(arrays.subtree_end)
    parent = np.asarray(arrays.parent)
    n = arrays.n_nodes

    alive = np.zeros(n, dtype=bool)
    for i in range(n):
        if int(end[i]) == i + 1 and arrays.labels[i] in keep:
            alive[i] = True
            up = int(parent[i])
            while 0 <= up < n and not alive[up]:
                alive[up] = True
                up = int(parent[up])

    def render(i: int) -> str | None:
        if not alive[i]:
            return None
        children = []
        c = i + 1
        while c < int(end[i]):
            if alive[c]:
                drawn = render(c)
                if drawn is not None:
                    children.append(drawn)
            c = int(end[c])
        label = arrays.labels[i]
        if not children:
            return label if int(end[i]) == i + 1 else None
        # A node left with one child is an artefact of pruning, not topology.
        if len(children) == 1:
            return children[0]
        return f"({','.join(children)}){label}"

    sys.setrecursionlimit(max(10_000, n))
    return f"{render(0)};"


def render(arrays, suffix: str = "") -> str:
    """Serialise `arrays`, optionally suffixing every LEAF label.

    Done from the parsed tree rather than by rewriting the Newick text. The
    first version used a regex with a `(?=[,)])` lookahead, which — because
    `to_newick` writes `name:length` — matched the **branch length** and left
    every label untouched: the "copies" were exact duplicates, the pair still
    had 17,645 distinct leaves at the 35,290 rung, and only a set-size check
    caught it.
    """
    end = np.asarray(arrays.subtree_end)
    branch = np.asarray(arrays.branch_len)
    sys.setrecursionlimit(max(10_000, arrays.n_nodes * 2))

    def one(i: int) -> str:
        is_leaf = int(end[i]) == i + 1
        label = arrays.labels[i]
        if is_leaf:
            label = f"{label}{suffix}"
            body = label
        else:
            parts = []
            c = i + 1
            while c < int(end[i]):
                parts.append(one(c))
                c = int(end[c])
            body = f"({','.join(parts)}){label}"
        length = float(branch[i])
        return body if np.isnan(length) else f"{body}:{length:.6f}"

    return one(0)


def nest(arrays, copies: int, ladder_tag: str) -> str:
    """Grow the tree by nesting relabelled copies, preserving depth.

    `ladder_tag` must be the SAME for both sides of a pair: copy *k* of the
    left tree has to carry the same leaf labels as copy *k* of the right, or
    the rung is not a comparison of two trees over one taxon set — it is two
    trees that share only their original half.
    """
    grown = render(arrays)
    for k in range(copies):
        # Nested, not siblings: a flat join of N copies under one root would
        # halve the effective depth and make the search artificially easy.
        grown = f"({grown},{render(arrays, f'_{ladder_tag}{k}')})"
    return f"{grown};"


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "ladder")
    out.mkdir(parents=True, exist_ok=True)

    left = parse_newick_file(LEFT)
    right = parse_newick_file(RIGHT)
    shared = sorted(set(leaves_of(left)) & set(leaves_of(right)))
    print(f"real pair: {left.n_leaves:,} / {right.n_leaves:,} leaves, {len(shared):,} shared")

    left_text = to_newick(left)
    right_text = to_newick(right)
    base = len(shared)

    for target in RUNGS:
        if target < base:
            random.seed(target)  # reproducible, and different per rung
            keep = set(random.sample(shared, target))
            a, b = prune(left_text, keep), prune(right_text, keep)
        elif target == base:
            a, b = left_text, right_text
        else:
            copies = max(1, round(target / base) - 1)
            a, b = nest(left, copies, "c"), nest(right, copies, "c")

        for side, text in (("a", a), ("b", b)):
            path = out / f"ladder-{target:06d}-{side}.nwk"
            path.write_text(text)
        got = a.count(",") + 1
        print(f"  {target:>7,} requested -> {got:>7,} leaves  ({path.stat().st_size / 1e6:.1f} MB each)")


if __name__ == "__main__":
    main()
