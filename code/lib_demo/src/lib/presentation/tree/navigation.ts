import type { LayoutNode } from "./layout";
import { getSubtreeLeaves } from "./model";

/**
 * Selection-to-structure queries over the *rendered* tree.
 *
 * The selection operator (and any context menu on top of it) hands the app a set
 * of **graph-node ids** — strings, the same keys `getNodeMap()` is keyed by. To
 * do anything useful with a selection (fetch its isolates, collapse the clade
 * around it) the app needs to turn those ids back into tree structure: the
 * concrete leaves they stand for, or their common ancestor.
 *
 * Doing that means walking `LayoutNode.source` and its `origin` back-reference —
 * exactly the pruning/clone internals the library otherwise hides. So these live
 * here, keyed by id in and id/name out, rather than forcing every app to reach
 * through `getNodeMap().get(id).source`. Pure functions over a node map, so they
 * are trivially testable without a viewer; {@link TreeViewer} exposes thin
 * wrappers (`leavesOf`, `mrcaOf`).
 */

type NodeMap = ReadonlyMap<string, LayoutNode>;

/**
 * The concrete leaf **names** a set of selected node ids represents.
 *
 * A selected leaf contributes itself. A selected clade — whether expanded or a
 * *collapsed* marker standing for a hidden subtree — contributes every leaf
 * under it in the **original** (un-pruned) tree, resolved through each node's
 * `origin`. So selecting a collapsed clade of 40 isolates yields all 40, not the
 * single marker id, which is what "fetch data for the selection" needs.
 *
 * Names are de-duplicated and returned in first-seen order. Unknown ids (and the
 * invisible connector nodes, which are absent from the map) are skipped; blank
 * leaf names are dropped, since they identify nothing to a backend.
 */
export function leafNamesOf(nodeMap: NodeMap, ids: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const ln = nodeMap.get(id);
    if (!ln) continue; // unknown id or invisible connector
    const root = ln.source.origin ?? ln.source;
    for (const leaf of getSubtreeLeaves(root)) {
      const name = leaf.name ?? "";
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * The graph id of the most-recent common ancestor of the given displayed nodes,
 * or `null` if none are known. One id in the set returns that id; ids that share
 * no ancestor (impossible within one rendered tree) also yield `null`.
 *
 * Computed over the displayed layout tree via `LayoutNode.children`, so the
 * result is always a node currently on screen — feed it straight to
 * {@link ExpandCollapseOperator.collapseNodes} to fold the clade around a leaf
 * selection.
 */
export function mrcaId(nodeMap: NodeMap, ids: Iterable<string>): string | null {
  const selected = [...ids].filter((id) => nodeMap.has(id));
  if (selected.length === 0) return null;
  if (selected.length === 1) return selected[0];

  // child id -> parent id, from the display tree's LayoutNode.children.
  const parent = new Map<string, string>();
  for (const [id, ln] of nodeMap) {
    for (const child of ln.children) {
      if (nodeMap.has(child.id)) parent.set(child.id, id);
    }
  }

  // The ancestor chain (self, ..., root) of one node. The `guard` set makes a
  // malformed cyclic map terminate rather than spin.
  const chainOf = (start: string): string[] => {
    const chain: string[] = [];
    const guard = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined && !guard.has(cur)) {
      chain.push(cur);
      guard.add(cur);
      cur = parent.get(cur);
    }
    return chain;
  };

  // Fold pairwise: MRCA(acc, next) is the deepest ancestor of `next` that is
  // also an ancestor of `acc`. `acc` is itself an ancestor id after the first
  // step, so this converges on the MRCA of the whole set.
  let acc = selected[0];
  for (let i = 1; i < selected.length; i++) {
    const ancestorsOfAcc = new Set(chainOf(acc));
    let found: string | null = null;
    for (const anc of chainOf(selected[i])) {
      if (ancestorsOfAcc.has(anc)) {
        found = anc;
        break;
      }
    }
    if (found === null) return null; // disconnected — not one tree
    acc = found;
  }
  return acc;
}
