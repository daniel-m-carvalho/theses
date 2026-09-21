"""Reduce a subtree to a leaf budget, largest clades first.

This mirrors the rendering library's ``prepareTree``
(``lib/src/presentation/tree/model.ts``). The library already does this in the
browser to keep a drawing tractable; doing it on the server is the same rule
applied one step earlier, so the bytes for the nodes that would have been
discarded are never sent at all. That is the whole client-side argument: not
"draw fewer nodes" but "never receive them".

The rule, from the library:

1. A budget of zero yields nothing.
2. A leaf costs one unit of budget.
3. Otherwise children are visited **largest subtree first**, so a tight budget
   keeps the most prominent clades rather than whichever happen to come first.
4. Each child is allotted ``max(1, min(its leaf count, what remains))``, and the
   remainder is drawn down by what that child actually produced -- not by what
   it was allotted, which is why siblings must be evaluated in order rather than
   apportioned up front.
5. A node whose children were all cut becomes a **terminal**: one displayed tip
   standing in for the whole subtree beneath it.
6. A node left with exactly one child collapses into that child, summing branch
   lengths, so depth reflects real branching rather than the truncation.

Two deliberate divergences, both because a slice crosses a wire
-----------------------------------------------------------------
**A clade that is not expanded is still shown, as a wedge.** An internal node
allotted a budget of one is emitted as a single tip carrying the true size of
the clade it stands for, rather than descended into for one arbitrary leaf. The
library can afford the latter: its pruned clone keeps an ``origin`` pointer back
to the real subtree, so nothing is lost in the browser. Across a wire there is
no pointer. A tip that is really 8,441 leaves must say so, or the client cannot
draw the wedge, size it, or know there is anything to navigate into.

**Budget is reserved so no sibling vanishes.** Taken literally, the library's
apportionment lets the largest child consume everything: measured on the vibrio
tree at a budget of 500, it descends into one corner, returns 500 real leaves,
and the other 17,146 disappear without trace. That is a sound *safety net* in
the browser, where the tree handed to ``prepareTree`` has already been collapsed
to something reasonable and the budget rarely binds. It is the wrong rule for
the first thing a user sees. Here each child is guaranteed one unit, so every
clade appears -- expanded if it fits, as a wedge if it does not.

The invariant that follows is the one worth testing: **every leaf of the full
subtree is accounted for**, either displayed or counted inside exactly one
wedge. A slice never loses anything silently; it only defers it.

The selection *priority* defaults to the library's: largest subtree first, so a
tight budget spends its detail on the most prominent clades. It is a parameter,
because for a comparison tool "biggest" is often the wrong question -- see
``divergence_priority``.

Two leaf counts, and why they are different
-------------------------------------------
``true_leaf_count`` is how many leaves a node has **in the full tree**, which is
what sizes a collapsed wedge and tells the user how much is hidden. It is not
the number of nodes returned beneath it. The library keeps the same distinction
via ``origin`` (``clade_shape.ts:161``); here the true count is simply carried,
since the server has it for free in the ``leaf_count`` column.

Implemented iteratively. The library recurses, which is fine in a browser on a
prepared tree, but here the recursion would follow the real tree: these are 604
levels deep, and a budget-driven descent down a caterpillar spine is bounded by
the budget, not the depth.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .store import TreeReader


@dataclass(slots=True)
class DisplayNode:
    """One node of a summarised subtree."""

    #: Pre-order index in the STORED tree. This is the join key for everything
    #: else -- comparison values, metadata, a later request for this subtree.
    id: int
    label: str
    branch_len: float
    #: Leaves beneath this node in the full tree, not in this slice.
    true_leaf_count: int
    #: True when this tip stands for a subtree that was not sent.
    truncated: bool
    children: list["DisplayNode"] = field(default_factory=list)


@dataclass(slots=True)
class _Frame:
    node: int
    children: list[int]
    index: int
    remaining: int
    leaves: int
    kept: list[DisplayNode]


class Summariser:
    """Summarises subtrees of one stored tree.

    ``priority`` scores each node; children are expanded highest-first. It
    decides *where the detail goes*, and nothing else -- the budget is still
    spent in leaves, and every child still gets at least a wedge, so a slice
    conserves its leaves under any priority.
    """

    def __init__(self, reader, priority: np.ndarray | None = None) -> None:
        self.reader = reader
        self.n = reader.meta.n_nodes
        # Asked per node, never taken as whole columns. A slice touches a few
        # hundred nodes out of hundreds of thousands, and a succinct store
        # would have to decompress the entire tree to hand over an array.
        self.priority = priority if priority is None else np.asarray(priority)
        if self.priority is not None and self.priority.shape[0] != self.n:
            raise ValueError(
                f"priority covers {self.priority.shape[0]} nodes, tree has {self.n}"
            )

    def _priority_of(self, i: int) -> float:
        """Ranking score for a node. Subtree size unless one was supplied."""
        if self.priority is None:
            return float(self.reader.leaf_count_of(i))
        return float(self.priority[i])

    def children_of(self, i: int) -> list[int]:
        """Direct children, from the interval encoding: no child list is stored.

        A node's first child is the next position; each subsequent child starts
        where the previous one's interval ends.
        """
        out: list[int] = []
        end = self.reader.subtree_end_of(i)
        c = i + 1
        while c < end:
            out.append(c)
            c = self.reader.subtree_end_of(c)
        return out

    def is_leaf(self, i: int) -> bool:
        return self.reader.subtree_end_of(i) == i + 1

    def _terminal(self, i: int, truncated: bool) -> DisplayNode:
        return DisplayNode(
            id=i,
            label=self.reader.label(i),
            branch_len=self.reader.branch_len_of(i),
            true_leaf_count=self.reader.leaf_count_of(i),
            truncated=truncated,
            children=[],
        )

    def summarise(self, root: int, budget: int) -> DisplayNode | None:
        """Summarise the subtree at ``root`` to at most ``budget`` leaves."""
        if not 0 <= root < self.n:
            raise IndexError(f"node {root} is outside this tree (0..{self.n - 1})")
        if budget <= 0:
            return None
        if self.is_leaf(root):
            return self._terminal(root, truncated=False)
        if budget == 1:
            return self._terminal(root, truncated=True)

        stack = [self._frame(root, budget)]
        completed: tuple[DisplayNode | None, int] | None = None

        while stack:
            frame = stack[-1]

            if completed is not None:
                node, leaves = completed
                completed = None
                if node is not None:
                    frame.kept.append(node)
                    frame.leaves += leaves
                    # Drawn down by what the child actually produced. A child
                    # can come back smaller than its allotment, and the budget
                    # that frees up belongs to its siblings.
                    frame.remaining -= max(1, leaves)

            if frame.remaining > 0 and frame.index < len(frame.children):
                child = frame.children[frame.index]
                frame.index += 1
                child_size = 1 if self.is_leaf(child) else self.reader.leaf_count_of(child)
                # Hold back one unit for each sibling still to come, so every
                # child gets at least a wedge and nothing disappears unseen.
                siblings_left = len(frame.children) - frame.index
                allotted = max(1, min(child_size, frame.remaining - siblings_left))
                if self.is_leaf(child):
                    completed = (self._terminal(child, truncated=False), 1)
                elif allotted == 1:
                    # One unit of budget buys one tip. Spend it on a wedge that
                    # reports the whole clade rather than on one leaf that
                    # misrepresents it as the only thing there.
                    completed = (self._terminal(child, truncated=True), 1)
                else:
                    stack.append(self._frame(child, allotted))
                continue

            stack.pop()
            completed = self._finish(frame)

        assert completed is not None
        return completed[0]

    def _frame(self, node: int, budget: int) -> _Frame:
        # Highest priority first: with a tight budget, these are the clades
        # worth the detail. Ties broken by index so the result is stable, which
        # is what lets a second request reproduce the same node set.
        children = sorted(
            self.children_of(node),
            key=lambda c: (-self._priority_of(c), c),
        )
        return _Frame(
            node=node, children=children, index=0,
            remaining=budget, leaves=0, kept=[],
        )

    def _finish(self, frame: _Frame) -> tuple[DisplayNode, int]:
        i = frame.node
        if not frame.kept:
            # Everything below was cut: this becomes one tip standing for the
            # whole subtree. Its true leaf count says how much is behind it.
            return self._terminal(i, truncated=True), 1

        if len(frame.kept) == 1:
            # Degree-1 chains are an artefact of truncation, not of the tree.
            # Collapse into the surviving child so displayed depth reflects real
            # branching, and add the lengths so distances are preserved.
            only = frame.kept[0]
            parent_len = self.reader.branch_len_of(i)
            merged_len = only.branch_len
            if not np.isnan(parent_len):
                merged_len = parent_len + (0.0 if np.isnan(only.branch_len) else only.branch_len)
            only.branch_len = merged_len
            return only, frame.leaves

        node = DisplayNode(
            id=i,
            label=self.reader.label(i),
            branch_len=self.reader.branch_len_of(i),
            true_leaf_count=self.reader.leaf_count_of(i),
            truncated=False,
            children=frame.kept,
        )
        return node, frame.leaves


def flatten(root: DisplayNode) -> dict[str, list]:
    """Pre-order flatten into the positional arrays the wire format uses.

    ``parent`` is an index into these same arrays (-1 at the slice root), not a
    stored-tree id, so a client can rebuild the nesting without a lookup table.
    Stored-tree ids stay in ``id``, which is what joins to comparison values.
    """
    ids: list[int] = []
    parents: list[int] = []
    labels: list[str] = []
    branch: list[float | None] = []
    true_leaves: list[int] = []
    truncated: list[bool] = []

    stack: list[tuple[DisplayNode, int]] = [(root, -1)]
    while stack:
        node, parent = stack.pop()
        position = len(ids)
        ids.append(node.id)
        parents.append(parent)
        labels.append(node.label)
        branch.append(None if node.branch_len is None or np.isnan(node.branch_len) else float(node.branch_len))
        true_leaves.append(node.true_leaf_count)
        truncated.append(node.truncated)
        for child in reversed(node.children):
            stack.append((child, position))

    return {
        "id": ids,
        "parent": parents,
        "label": labels,
        "branch_len": branch,
        "true_leaf_count": true_leaves,
        "truncated": truncated,
    }


def count_leaves(root: DisplayNode) -> int:
    """Displayed leaves in a summarised subtree -- what the budget bounds."""
    total, stack = 0, [root]
    while stack:
        node = stack.pop()
        if not node.children:
            total += 1
        else:
            stack.extend(node.children)
    return total


def divergence_priority(
    similarity: np.ndarray, parent: np.ndarray
) -> np.ndarray:
    """Score each node by the worst disagreement anywhere beneath it.

    Used for ``order=difference``: spend the budget descending towards the
    changes rather than towards the biggest clades. For a comparison tool that
    is usually the more useful question, and **only the server can answer it** --
    the client cannot reorder by values it has not been sent yet.

    The score is ``max(1 - similarity)`` over the subtree: "the best thing
    reachable below here", which is the natural heuristic for a greedy descent.
    A node with no counterpart counts as fully diverged (1.0), since a leaf
    present in only one tree is a real difference rather than a missing
    measurement.

    Three measures were implemented and compared on the vibrio pair, scored by
    how many of the 50 most-diverged substantial clades (>=20 leaves,
    similarity 0.04-0.23) a slice actually contains:

    ====================  ==========  ==========  ==========
    priority              budget 100  budget 200  budget 500
    ====================  ==========  ==========  ==========
    size (the default)         2%         22%         22%
    sum of 1 - similarity      2%         22%         22%
    mean of 1 - similarity     0%         14%         24%
    **max of 1 - similarity**  **14%**    **24%**     **24%**
    ====================  ==========  ==========  ==========

    The two rejected alternatives, and why they fail:

    * **sum** -- scales with the number of nodes underneath, so it re-derives
      subtree size (rank correlation with size 0.57) and behaves identically to
      ``size``. This is the same trap as counting non-exact clades, which RF's
      saturation (S2.7) makes useless for the same reason.
    * **mean** -- dilutes: one badly diverged clade inside a large, otherwise
      well-matched subtree is averaged away, so the descent never finds it.

    ``max`` separates from ``size`` exactly where it matters, at tight budgets:
    seven times the recall at 100 tips. The measures converge as the budget
    grows, because a generous budget reaches most things whatever order it
    visits them in.

    Computed by one reverse pass over pre-order: a node's children always follow
    it, so by the time the loop reaches a node its descendants are final.
    """
    diverged = np.where(np.isnan(similarity), 1.0, 1.0 - similarity.astype(np.float64))
    from .newick import NO_PARENT

    for i in range(len(diverged) - 1, 0, -1):
        p = int(parent[i])
        if p != NO_PARENT and diverged[i] > diverged[p]:
            diverged[p] = diverged[i]
    return diverged
