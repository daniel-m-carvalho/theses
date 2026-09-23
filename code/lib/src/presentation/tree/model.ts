import type { ChildOrder, IsCollapsed, NewickNode } from "./types";

/**
 * Pure, side-effect-free operations over the {@link NewickNode} tree model:
 * metrics (depth, distance, leaf counts), traversal (leaf collection),
 * re-rooting, and budget-based pruning. Everything here is independent of
 * Sigma/graphology and is reused by every layout engine and operator.
 */

// --- Metrics ---

/** Maximum root-to-leaf distance, summing branch lengths. */
export function maxRootDist(node: NewickNode, dist = 0): number {
  const d = dist + (node.length || 0);
  if (!node.branchset?.length) return d;
  return Math.max(...node.branchset.map((c) => maxRootDist(c, d)));
}

/** Maximum depth in edges (root = 0). */
export function maxDepth(node: NewickNode, depth = 0): number {
  if (!node.branchset?.length) return depth;
  return Math.max(...node.branchset.map((c) => maxDepth(c, depth + 1)));
}

/**
 * Memo caches for the subtree-derived values used as *sort keys*.
 *
 * Why this matters: `prepareTree` sorts siblings with comparators that ask for a
 * subtree-wide value (leaf count, smallest leaf name). A comparator runs
 * O(k log k) times per node, and each call used to re-walk the whole subtree —
 * making a build O(n²·log n). Measured on the 17.6k-leaf vibrio tree, that was
 * 1164ms at a 5000-leaf budget, growing 12× for a 5× node increase.
 *
 * Keyed on the node object in a WeakMap, so entries are collected with the tree
 * and nothing leaks. **Assumes a node's subtree is not mutated after being
 * measured** — which holds here because every transform clones: `prepareTree`
 * builds new nodes, `rerootTree` clones before restructuring. The source tree is
 * stable across re-renders, so its memo is also reused by every later rebuild.
 */
const leafCountCache = new WeakMap<NewickNode, number>();
const minLeafNameCache = new WeakMap<NewickNode, string>();
const minLeafNumberCache = new WeakMap<NewickNode, number>();

/**
 * Bottom-up memoized fold over a subtree's leaves.
 *
 * The shape every subtree-derived sort key needs: define the value at a leaf,
 * and how to combine two children's values. One call fills the cache for **every
 * node in the subtree**, so the total cost of keying a whole tree is O(n) rather
 * than O(n) per node — which is what made ordering quadratic.
 *
 * Iterative rather than recursive: UPGMA/NJ produce ladder-shaped clades (the
 * vibrio tree is 443 deep on 17.6k leaves), and deeper datasets would overflow
 * the call stack.
 */
function foldLeaves<T>(
  node: NewickNode,
  cache: WeakMap<NewickNode, T>,
  ofLeaf: (leaf: NewickNode) => T,
  combine: (a: T, b: T) => T
): T {
  const hit = cache.get(node);
  if (hit !== undefined) return hit;

  const pending: NewickNode[] = [];
  const stack: NewickNode[] = [node];

  // Descend, recording internal nodes in visit order; leaves resolve immediately.
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (cache.has(current)) continue; // already folded on an earlier call
    if (!current.branchset?.length) {
      cache.set(current, ofLeaf(current));
      continue;
    }
    pending.push(current);
    for (const child of current.branchset) stack.push(child);
  }

  // Children always land after their parent above, so reverse order resolves
  // bottom-up: every child is cached before the parent that combines them.
  for (let i = pending.length - 1; i >= 0; i--) {
    const n = pending[i];
    let acc: T | undefined;
    for (const child of n.branchset!) {
      const value = cache.get(child) as T;
      acc = acc === undefined ? value : combine(acc, value);
    }
    cache.set(n, acc as T);
  }

  return cache.get(node) as T;
}

/** Number of leaves under a node (used for sizing/ordering). Memoized. */
export function subtreeSize(node: NewickNode): number {
  return countLeaves(node);
}

/** Number of leaves under a node (alias kept for readability at call sites). */
export function countLeaves(node: NewickNode): number {
  return foldLeaves(node, leafCountCache, () => 1, (a, b) => a + b);
}

/** Lexicographically smallest leaf name in the subtree (memoized, O(n) total). */
function minLeafName(node: NewickNode): string {
  return foldLeaves(
    node,
    minLeafNameCache,
    (leaf) => leaf.name || "",
    (a, b) => (b.localeCompare(a, undefined, { numeric: true }) < 0 ? b : a)
  );
}

/** Smallest finite numeric leaf name in the subtree; Infinity if none. */
function minLeafNumber(node: NewickNode): number {
  return foldLeaves(
    node,
    minLeafNumberCache,
    (leaf) => {
      const v = Number(leaf.name);
      return Number.isFinite(v) ? v : Infinity;
    },
    (a, b) => Math.min(a, b)
  );
}

/** Collect all leaf nodes under (and including, if itself a leaf) `node`. */
export function getSubtreeLeaves(node: NewickNode): NewickNode[] {
  if (!node.branchset?.length) return [node];
  const leaves: NewickNode[] = [];
  const stack: NewickNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!current.branchset?.length) {
      leaves.push(current);
    } else {
      for (const c of current.branchset) stack.push(c);
    }
  }
  return leaves;
}

// --- Re-rooting ---

/**
 * Re-root the tree on the edge leading to the node matching `targetName`
 * (a leaf or internal/clade name). The chosen node becomes a direct sibling
 * of the rest of the tree under a new root, with the original edge's length
 * split evenly between the two new branches.
 *
 * Returns a new tree (does not mutate the input). Returns null if
 * `targetName` is not found, or if it's already the root (nothing to do).
 */
export function rerootTree(tree: NewickNode, targetName: string): NewickNode | null {
  const clone = (n: NewickNode): NewickNode => ({
    name: n.name,
    length: n.length,
    category: n.category,
    metadata: n.metadata,
    branchset: n.branchset?.map(clone),
  });
  const root = clone(tree);

  if (root.name === targetName) return null; // already the root

  interface PathEntry {
    node: NewickNode;
    parent: NewickNode | null;
    idx: number;
  }

  function findPath(
    node: NewickNode,
    parent: NewickNode | null,
    idx: number,
    path: PathEntry[]
  ): PathEntry[] | null {
    const entry: PathEntry = { node, parent, idx };
    if (node.name === targetName) return [...path, entry];
    if (!node.branchset) return null;
    for (let i = 0; i < node.branchset.length; i++) {
      const found = findPath(node.branchset[i], node, i, [...path, entry]);
      if (found) return found;
    }
    return null;
  }

  const path = findPath(root, null, -1, []);
  if (!path) return null; // not found
  if (path.length === 1) return null; // is the root itself

  const target = path[path.length - 1].node;
  const targetParent = path[path.length - 2].node;
  const targetIdx = path[path.length - 1].idx;
  const targetEdgeLength = target.length || 0;

  // Detach target from its parent.
  targetParent.branchset!.splice(targetIdx, 1);
  if (targetParent.branchset!.length === 0) targetParent.branchset = undefined;

  // Reverse each edge on the path up to the original root, nesting ancestors
  // inside `attachPoint`. `treeTop` ends up holding the entire reversed chain
  // and becomes the second branch of the new root.
  let attachPoint = targetParent;
  const treeTop = targetParent;

  for (let i = path.length - 2; i >= 1; i--) {
    const parent = path[i].parent!;
    const idx = path[i].idx;
    const edgeLength = attachPoint.length || 0;

    parent.branchset!.splice(idx, 1);
    if (parent.branchset!.length === 0) parent.branchset = undefined;
    parent.length = edgeLength;
    attachPoint.branchset = attachPoint.branchset || [];
    attachPoint.branchset.push(parent);
    attachPoint = parent;
  }

  const half = targetEdgeLength / 2;
  target.length = half;
  treeTop.length = half;

  return { name: "", length: 0, branchset: [target, treeTop] };
}

// --- Ordering (branch rotation) ---

/**
 * Representative numeric key for a node: its own numeric name if it has one
 * (e.g. a goeBURST ST id on an internal clade), otherwise the smallest numeric
 * leaf name in its subtree (NJ/UPGMA internals are unnamed). Non-numeric names
 * fall back to +Infinity so they sort last, deterministically.
 */
function numericKey(node: NewickNode): number {
  const own = Number(node.name);
  if (Number.isFinite(own)) return own;
  return minLeafNumber(node);
}

/**
 * True if a name is *informative* for ordering — i.e. it carries at least one
 * alphanumeric character. Newick placeholders like `_` (used by our NJ/UPGMA
 * exports to mark unnamed internal nodes) are treated as absent, so ordering
 * falls through to the subtree's leaves instead of keying every internal node
 * on the same placeholder string.
 */
function hasInformativeName(name: string | undefined): name is string {
  return !!name && /[A-Za-z0-9]/.test(name);
}

/**
 * Representative string key for a node: its own name if it has an informative
 * one (e.g. a goeBURST ST id on an internal clade), otherwise the
 * lexicographically smallest leaf name in its subtree (NJ/UPGMA internals are
 * named with the `_` placeholder, treated as unnamed). Unlike {@link numericKey},
 * this is defined for any label — numeric or not — so it never collapses
 * non-numeric names to a single bucket.
 */
function nameKey(node: NewickNode): string {
  if (hasInformativeName(node.name)) return node.name;
  return minLeafName(node);
}

/**
 * Comparator used for lexicographic ordering. `numeric: true` keeps embedded
 * numbers in natural order (so "st2" precedes "st10"), while still ordering any
 * non-numeric labels lexicographically. `sensitivity: "base"` makes it
 * case-insensitive so "A" and "a" sort together.
 */
function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Default ordering: ascending lexicographic (by label). Orders sibling clades
 * by {@link nameKey}, so leaves read top-to-bottom in label order while the
 * tree structure is untouched. Works for any labels — numeric ids, strain
 * names, or mixed — because it compares strings, not parsed numbers.
 */
export const orderByName: ChildOrder = (a, b) => compareLabels(nameKey(a), nameKey(b));

/**
 * Ascending numeric ordering (ladderize by id). Orders sibling clades by
 * {@link numericKey}; non-numeric labels sort last. Prefer {@link orderByName}
 * for datasets whose labels aren't purely numeric.
 */
export const orderByNumeric: ChildOrder = (a, b) => {
  const ka = numericKey(a);
  const kb = numericKey(b);
  return ka === kb ? 0 : ka - kb;
};

/** Largest-subtree-first ordering (the previous default). */
export const orderBySizeDesc: ChildOrder = (a, b) => subtreeSize(b) - subtreeSize(a);

// --- Pruning / ordering ---

/**
 * Recursively select up to `leafBudget` leaves total under `node`, preferring
 * larger subtrees, and rebuild a pruned tree. `leafBudget` is a leaf-count
 * budget (not a node-count budget) so it splits cleanly among siblings.
 *
 * Two independent concerns:
 *  - *Selection* — which clades survive the budget — always favours larger
 *    subtrees, so the displayed subset stays representative. This is pruning
 *    for density, not a structural change.
 *  - *Ordering* — the vertical order of the survivors — is the modular `order`
 *    comparator (default {@link orderByName}). Reordering siblings is a
 *    branch rotation: it never alters topology, so the tree stays legal and
 *    cladogram/phylogram x-positioning is unaffected.
 */
export function prepareTree(
  node: NewickNode,
  isCollapsed: IsCollapsed,
  leafBudget: number,
  order: ChildOrder = orderByName
): NewickNode | null {
  return prepareSubtree(node, isCollapsed, leafBudget, order)?.node ?? null;
}

/** A prepared subtree plus its leaf count, threaded up to avoid re-walking. */
interface PreparedSubtree {
  node: NewickNode;
  leaves: number;
}

/**
 * Recursive worker for {@link prepareTree}.
 *
 * Returns the leaf count alongside the node. The count is needed to draw down
 * the budget, and computing it with `countLeaves(prepared)` meant re-walking a
 * freshly built subtree (never memo-able, since each call creates new objects)
 * once per child at every level — O(n·depth), which dominated the build on deep
 * trees. Threading it up makes it O(1) per child. Each built node is also seeded
 * into the leaf-count memo so later consumers (layout, clade shapes) get it free.
 */
function prepareSubtree(
  node: NewickNode,
  isCollapsed: IsCollapsed,
  leafBudget: number,
  order: ChildOrder
): PreparedSubtree | null {
  if (leafBudget <= 0) return null;

  const isLeaf = !node.branchset?.length;
  // A node may arrive already flagged collapsed, with no children, because a
  // server summarised it away. That is a clade, not a leaf: without this it
  // would draw as an ordinary tip and the fact that it stands for thousands
  // of leaves would be lost.
  const collapsedHere = node.collapsed === true || (!isLeaf && isCollapsed(node));

  if (isLeaf || collapsedHere) {
    return terminal(
      {
        name: node.name,
        length: node.length,
        category: node.category,
        metadata: node.metadata,
        // Carried, not recomputed: nothing local can know it.
        trueLeafCount: node.trueLeafCount,
        collapsed: collapsedHere,
        branchset: undefined,
        origin: node,
      }
    );
  }

  // Selection: visit largest subtrees first so the budget keeps the most
  // prominent clades (independent of how they'll be ordered for display).
  const bySize = [...(node.branchset || [])].sort(
    (a, b) => subtreeSize(b) - subtreeSize(a)
  );

  const newChildren: NewickNode[] = [];
  let leaves = 0;
  let remaining = leafBudget;

  for (const child of bySize) {
    if (remaining <= 0) break;
    const childSize =
      isCollapsed(child) || !child.branchset?.length ? 1 : subtreeSize(child);
    const allotted = Math.max(1, Math.min(childSize, remaining));
    const prepared = prepareSubtree(child, isCollapsed, allotted, order);
    if (prepared) {
      newChildren.push(prepared.node);
      leaves += prepared.leaves;
      remaining -= Math.max(1, prepared.leaves);
    }
  }

  if (newChildren.length === 0) {
    return terminal({
      name: node.name,
      length: node.length,
      category: node.category,
      metadata: node.metadata,
      branchset: undefined,
      origin: node,
    });
  }

  // Collapse degree-1 chains so depth reflects real branching. The surviving
  // child is what's shown, so inherit its origin (toggling this display node
  // acts on that child clade).
  if (newChildren.length === 1) {
    const only = newChildren[0];
    return memoized(
      {
        name: only.name,
        length: (node.length || 0) + (only.length || 0),
        category: only.category,
        metadata: only.metadata,
        branchset: only.branchset,
        origin: only.origin ?? node,
      },
      leaves
    );
  }

  // Display order: rotate siblings into the requested order (structure-preserving).
  newChildren.sort(order);

  return memoized(
    {
      name: node.name,
      length: node.length,
      category: node.category,
      metadata: node.metadata,
      branchset: newChildren,
      origin: node,
    },
    leaves
  );
}

/** A prepared tip: exactly one leaf. */
function terminal(node: NewickNode): PreparedSubtree {
  return memoized(node, 1);
}

/** Seed the leaf-count memo for a freshly built node and return it with its count. */
function memoized(node: NewickNode, leaves: number): PreparedSubtree {
  leafCountCache.set(node, leaves);
  return { node, leaves };
}
