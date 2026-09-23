/**
 * A server slice, as the viewer wants it.
 *
 * The API speaks parallel arrays in pre-order; `phylo-tree-viewer` speaks
 * `NewickNode`. This is the seam, and it carries the one thing the rest of the
 * app depends on: a way back from a node the user clicked to the **stored id**
 * the server knows it by. Without that, a right-click could not ask the server
 * to expand what was clicked.
 *
 * A truncated tip becomes `collapsed: true`, which is what the library's clade
 * shaping draws as a wedge. That is the whole mechanism by which a 500k-leaf
 * tree arrives as a few hundred nodes: what is not expanded is a wedge that
 * says how many leaves it stands for, and expanding it is another request.
 */

import type { NewickNode } from "phylo-tree-viewer";
import type { TreeSlice } from "../api/types";

export interface SliceTree {
  root: NewickNode;
  /** Stored id for a node, following `origin` when the library cloned it. */
  storedIdOf: (node: NewickNode) => number | undefined;
  /** Leaves this node stands for in the FULL tree, not just in this slice. */
  trueLeafCountOf: (node: NewickNode) => number | undefined;
  /** Nodes in this slice, by stored id, so a comparison value can be found. */
  byStoredId: Map<number, NewickNode>;
  /** Index into the slice arrays, by stored id — for comparison lookups. */
  indexOfStoredId: Map<number, number>;
  truncated: Set<number>;
}

/**
 * A node the viewer can draw, plus the maps that let a click reach the server.
 *
 * Throws on a malformed slice rather than rendering a partial tree: a parent
 * index pointing outside the arrays means the response and this code disagree
 * about the contract, and drawing half a tree would hide that.
 */
/**
 * Labels that carry no identity.
 *
 * `"_"` is not a backend invention — it is what the source Newick writes for
 * an unnamed internal node, and in the vibrio tree 97 of 119 sliced nodes
 * carry it. It is blanked rather than kept, because the layout draws a node's
 * name as its label: left alone, every internal node on screen was captioned
 * `_`, and an earlier attempt to make them unique captioned them `node-10251`,
 * which is worse — a made-up identifier presented as if it meant something.
 *
 * Identity does not travel in the name. It travels in `metadata.storedId`,
 * which is the only thing that survives the library's own key generation.
 */
const UNLABELLED = new Set(["", "_"]);

export function treeFromSlice(slice: TreeSlice): SliceTree {
  const { id, parent, label, branch_len, true_leaf_count, truncated } = slice.nodes;
  const count = id.length;
  if (count === 0) throw new Error("slice contains no nodes");

  const storedId = new WeakMap<NewickNode, number>();
  const trueLeaves = new WeakMap<NewickNode, number>();
  const byStoredId = new Map<number, NewickNode>();
  const indexOfStoredId = new Map<number, number>();
  const truncatedIds = new Set<number>();

  const nodes: NewickNode[] = new Array(count);
  for (let k = 0; k < count; k += 1) {
    const node: NewickNode = {
      name: UNLABELLED.has(label[k]) ? "" : label[k],
      // What this node stands for in the FULL tree. The library sizes a wedge
      // and labels its tooltip from this; nothing local could work it out,
      // because a summarised clade arrives with no children to count.
      trueLeafCount: true_leaf_count[k],
      metadata: {
        storedId: id[k],
        trueLeafCount: true_leaf_count[k],
        truncated: truncated[k] ? 1 : 0,
        // The label exactly as sent, for the menu title.
        label: label[k],
      },
    };
    const length = branch_len[k];
    if (length !== null && length !== undefined) node.length = length;
    // A truncated tip stands for a clade nobody asked to expand. Marking it
    // collapsed is what makes the library draw a wedge rather than a leaf.
    if (truncated[k]) {
      node.collapsed = true;
      truncatedIds.add(id[k]);
    }

    nodes[k] = node;
    storedId.set(node, id[k]);
    trueLeaves.set(node, true_leaf_count[k]);
    byStoredId.set(id[k], node);
    indexOfStoredId.set(id[k], k);
  }

  let root: NewickNode | undefined;
  for (let k = 0; k < count; k += 1) {
    const at = parent[k];
    if (at === -1) {
      if (root) throw new Error("slice has more than one root");
      root = nodes[k];
      continue;
    }
    if (at < 0 || at >= count) {
      throw new Error(`node ${k} has parent index ${at}, outside the slice`);
    }
    const father = nodes[at];
    (father.branchset ??= []).push(nodes[k]);
  }
  if (!root) throw new Error("slice has no root");

  // `prepareTree` clones, leaving `origin` pointing at what it was made from,
  // so a displayed node is not identity-equal to the one built here.
  const resolve = (node: NewickNode): NewickNode => node.origin ?? node;

  return {
    root,
    storedIdOf: (node) => storedId.get(resolve(node)) ?? storedId.get(node),
    trueLeafCountOf: (node) => trueLeaves.get(resolve(node)) ?? trueLeaves.get(node),
    byStoredId,
    indexOfStoredId,
    truncated: truncatedIds,
  };
}
