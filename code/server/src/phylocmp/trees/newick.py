"""Newick -> columnar arrays, in one pass, in pre-order.

Why pre-order with an interval encoding
---------------------------------------
Every node gets its position in a pre-order walk as its identity, and stores
``subtree_end``: the exclusive end of the contiguous range its descendants
occupy. Two things fall out of that one layout:

* **Slicing is O(1).** The subtree rooted at ``i`` is exactly the index range
  ``[i, subtree_end[i])`` in every column. Serving a subtree is a memcpy, not a
  traversal, and no index of "which nodes belong to this subtree" is needed.
* **Robinson-Foulds is linear.** The interval is also the cluster: the leaves
  under ``i`` are the leaf-numbered entries of that same range. This is the
  structure Day (1985) builds to make RF linear, so the comparison index and the
  serving index are the same bytes on disk rather than two representations to
  keep in step.

Why not a library
-----------------
``ete3`` is effectively unmaintained and builds a Python object per node, which
is exactly the cost being avoided; ``Bio.Phylo`` likewise. Parsing 17.6k leaves
into flat arrays is ~200 lines and removes a heavy dependency from the hot path.

Parsing is **iterative**. Recursion is not safe here: the real trees are deeply
unbalanced (the vibrio UPGMA tree is 443 levels deep where a balanced tree of
that size would be ~15), and a recursive descent parser recurses once per level.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Sentinel in ``parent`` for the root. u32 max, so the column stays unsigned.
NO_PARENT = np.uint32(0xFFFFFFFF)

_LABEL_STOP = frozenset("(),:;")
_WHITESPACE = frozenset(" \t\r\n")


@dataclass(frozen=True, slots=True)
class TreeArrays:
    """A tree as columns, each indexed by pre-order position.

    All arrays have length ``n_nodes`` and are index-aligned: everything known
    about node ``i`` is at offset ``i`` of some column.
    """

    parent: np.ndarray  # u32, NO_PARENT at the root
    subtree_end: np.ndarray  # u32, exclusive; leaves have subtree_end == i + 1
    depth: np.ndarray  # u16, root is 0
    leaf_count: np.ndarray  # u32, leaves under i in the FULL tree
    branch_len: np.ndarray  # f32, NaN when the Newick gave no length
    labels: list[str]  # "" when unnamed

    @property
    def n_nodes(self) -> int:
        return int(self.parent.shape[0])

    @property
    def n_leaves(self) -> int:
        return int(self.leaf_count[0]) if self.n_nodes else 0

    @property
    def max_depth(self) -> int:
        return int(self.depth.max()) if self.n_nodes else 0

    def is_leaf(self, i: int) -> bool:
        return bool(self.subtree_end[i] == i + 1)


def _read_label(text: str, i: int, n: int) -> tuple[int, str, float]:
    """Read ``name[:length]`` starting at ``i``. Returns the new position."""
    # Name. Quoted names may contain the structural characters, so they are
    # scanned separately; EnteroBase ST ids never need it, other sources do.
    if i < n and text[i] in "'\"":
        quote = text[i]
        i += 1
        parts: list[str] = []
        while i < n:
            if text[i] == quote:
                # Newick escapes a quote inside a quoted label by doubling it,
                # so a doubled pair is one literal character, not the end.
                if i + 1 < n and text[i + 1] == quote:
                    parts.append(quote)
                    i += 2
                    continue
                i += 1  # closing quote
                break
            parts.append(text[i])
            i += 1
        name = "".join(parts)
    else:
        start = i
        while i < n and text[i] not in _LABEL_STOP:
            i += 1
        name = text[start:i].strip()

    # Optional branch length.
    length = float("nan")
    if i < n and text[i] == ":":
        i += 1
        start = i
        while i < n and text[i] not in _LABEL_STOP:
            i += 1
        raw = text[start:i].strip()
        if raw:
            try:
                length = float(raw)
            except ValueError:
                # A malformed length is not worth failing a 900 KB file over;
                # it becomes NaN like an absent one, and the topology stands.
                length = float("nan")

    return i, name, length


def parse_newick(text: str) -> TreeArrays:
    """Parse one Newick tree into columns.

    Nodes are allocated in the order they are *opened*, which is precisely
    pre-order: an internal node is allocated at its ``(`` and a leaf at its
    label, so a node always precedes its descendants and its descendants are
    contiguous.
    """
    n = len(text)
    parents: list[int] = []
    ends: list[int] = []
    lengths: list[float] = []
    labels: list[str] = []
    stack: list[int] = []  # internal nodes opened but not yet closed

    def allocate() -> int:
        idx = len(parents)
        parents.append(stack[-1] if stack else -1)
        ends.append(0)  # filled when the node closes
        lengths.append(float("nan"))
        labels.append("")
        return idx

    i = 0
    while i < n:
        c = text[i]

        if c in _WHITESPACE:
            i += 1
        elif c == "(":
            stack.append(allocate())
            i += 1
        elif c == ",":
            i += 1
        elif c == ")":
            if not stack:
                raise ValueError(f"unbalanced ')' at offset {i}")
            idx = stack.pop()
            # Every node allocated since idx is one of its descendants, so the
            # current allocation count is the exclusive end of its interval.
            ends[idx] = len(parents)
            i += 1
            i, labels[idx], lengths[idx] = _read_label(text, i, n)
        elif c == ";":
            break
        else:
            idx = allocate()
            i, labels[idx], lengths[idx] = _read_label(text, i, n)
            ends[idx] = idx + 1
            if idx == 0:
                break  # a bare leaf is the whole tree

    if stack:
        raise ValueError(f"unbalanced '(': {len(stack)} node(s) left open")
    if not parents:
        raise ValueError("empty tree")

    count = len(parents)
    parent = np.array(
        [NO_PARENT if p < 0 else p for p in parents], dtype=np.uint32
    )
    subtree_end = np.array(ends, dtype=np.uint32)
    branch_len = np.array(lengths, dtype=np.float32)

    depth = np.zeros(count, dtype=np.uint16)
    leaf_count = np.zeros(count, dtype=np.uint32)

    # Depth forwards: a parent always precedes its children in pre-order, so one
    # pass suffices and no traversal is needed.
    for idx in range(1, count):
        d = int(depth[parent[idx]]) + 1
        if d > 0xFFFF:
            # u16 would wrap silently and corrupt every downstream depth. These
            # trees are unbalanced but nowhere near this deep (443 for vibrio
            # UPGMA); if a dataset ever is, the column widens, it does not wrap.
            raise ValueError(f"tree deeper than {0xFFFF} levels at node {idx}")
        depth[idx] = d

    # Leaf counts backwards, for the mirror-image reason: a node's children all
    # sit after it, so by the time the loop reaches a node its children have
    # already contributed. This is a fold over the whole tree without recursion.
    for idx in range(count - 1, -1, -1):
        if subtree_end[idx] == idx + 1:
            leaf_count[idx] = 1
        p = parent[idx]
        if p != NO_PARENT:
            leaf_count[p] += leaf_count[idx]

    return TreeArrays(
        parent=parent,
        subtree_end=subtree_end,
        depth=depth,
        leaf_count=leaf_count,
        branch_len=branch_len,
        labels=labels,
    )


def parse_newick_fast(text: str) -> TreeArrays:
    """Parse with the native extension when it is built, else in Python.

    The two are checked against each other column for column on every tree in
    the corpus, so this is a speed choice and not a behaviour one. The Python
    implementation stays the reference: it is what produced the numbers this
    project reports, and it is what runs where no compiler exists.
    """
    import numpy as np

    from . import native

    extension = native.extension()
    if extension is None:
        return parse_newick(text)

    columns = extension.parse_newick(text)
    return TreeArrays(
        parent=columns["parent"],
        subtree_end=columns["subtree_end"],
        depth=columns["depth"],
        leaf_count=columns["leaf_count"],
        branch_len=columns["branch_len"],
        labels=columns["labels"],
    )


def parse_newick_file(path, fast: bool = False) -> TreeArrays:
    from pathlib import Path

    text = Path(path).read_text(encoding="utf-8")
    return parse_newick_fast(text) if fast else parse_newick(text)
