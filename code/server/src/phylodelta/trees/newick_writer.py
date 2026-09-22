"""Write a stored tree back out as Newick.

Nothing else in this project needs this — trees arrive as Newick and leave as
slices — but a **subprocess metric** does. Third-party comparison tools
(TreeDiff, tqDist, GTP) all take Newick files, and the trees they must be given
are the *reconciled* ones, which exist only in memory: reconciliation restricts
both trees to their shared leaves and re-canonicalises, and the result is never
stored (``trees.reconcile``). So a pair has to be materialised per comparison.

Iterative, for the same reason ``summarise`` is: the real trees are 604 levels
deep, and a recursive writer would follow every level.

Two details that are not decoration
-----------------------------------
**Branch lengths are optional, and omitting them changes what a tool computes.**
``branch_len`` is NaN where the source gave no length, and such a node is
written with no ``:length`` at all. This matters beyond fidelity: TreeDiff
infers *weighted* mode from the first ``:`` it sees and silently computes wRF
instead of RF, so a caller wanting a topological distance must ask for lengths
to be dropped. Hence ``include_lengths``.

**Labels are quoted when they have to be.** A label containing a structural
character would otherwise produce a file that reparses into a different tree.
The datasets here are integer sequence types and never need it, which is luck
rather than a guarantee.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .newick import TreeArrays

#: Characters that end a label in Newick, so a label containing one must be quoted.
_NEEDS_QUOTING = set("(),:;[]' \t\n")


def _escape(label: str) -> str:
    if not label:
        return ""
    if any(c in _NEEDS_QUOTING for c in label):
        return "'" + label.replace("'", "''") + "'"
    return label


def _format_length(value: float, precision: int) -> str:
    # `%.{p}g` keeps the shortest form that survives a round-trip at this
    # precision, rather than padding every length to a fixed width.
    return f"{value:.{precision}g}"


def to_newick(
    arrays: TreeArrays,
    include_lengths: bool = True,
    include_internal_labels: bool = True,
    precision: int = 12,
) -> str:
    """Serialise ``arrays`` as a one-line Newick string terminated by ``;``.

    ``include_lengths=False`` writes topology only — which is how a caller asks
    a tool for an unweighted distance (see the module docstring).
    """
    if arrays.n_nodes == 0:
        raise ValueError("cannot serialise an empty tree")

    end = np.asarray(arrays.subtree_end)
    branch = np.asarray(arrays.branch_len)

    def suffix(i: int) -> str:
        is_leaf = int(end[i]) == i + 1
        out = ""
        if is_leaf or include_internal_labels:
            out = _escape(arrays.labels[i])
        if include_lengths:
            length = float(branch[i])
            if not math.isnan(length):
                out += ":" + _format_length(length, precision)
        return out

    def children(i: int) -> list[int]:
        out: list[int] = []
        c = i + 1
        stop = int(end[i])
        while c < stop:
            out.append(c)
            c = int(end[c])
        return out

    # A stack of either a node to expand or a literal to emit. Expanding a node
    # pushes its closing literal first, then its children interleaved with
    # commas, so the whole tree is written without recursion.
    pieces: list[str] = []
    stack: list[tuple[str, object]] = [("node", 0)]
    while stack:
        kind, value = stack.pop()
        if kind == "literal":
            pieces.append(value)  # type: ignore[arg-type]
            continue

        i = int(value)  # type: ignore[arg-type]
        if int(end[i]) == i + 1:
            pieces.append(suffix(i))
            continue

        pieces.append("(")
        items: list[tuple[str, object]] = [("literal", ")" + suffix(i))]
        for child in reversed(children(i)):
            items.append(("node", child))
            items.append(("literal", ","))
        items.pop()  # the comma pushed before the first child
        stack.extend(items)

    return "".join(pieces) + ";"


def write_newick(
    path: Path,
    arrays: TreeArrays,
    include_lengths: bool = True,
    include_internal_labels: bool = True,
) -> Path:
    """Write ``arrays`` to ``path`` and return it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        to_newick(
            arrays,
            include_lengths=include_lengths,
            include_internal_labels=include_internal_labels,
        ),
        encoding="utf-8",
    )
    return path
