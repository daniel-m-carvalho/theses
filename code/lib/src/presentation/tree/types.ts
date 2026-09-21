/**
 * Core tree data shape, shared across the whole demo.
 *
 * This matches the structure produced by parsing a Newick string (the
 * `newick` package), but is also consumable as a plain JSON object — a
 * backend could send a subtree directly without any client-side parsing.
 */
export interface NewickNode {
  name: string;
  length?: number;
  branchset?: NewickNode[];
  /**
   * Optional category/identifier used by the bar-chart operator. When absent,
   * the leaf `name` is used as its identifier.
   */
  category?: string;
  /**
   * Arbitrary per-leaf metadata sent by the backend embedded in the leaf JSON
   * (e.g. sampling date, source, host — alongside {@link category}). The library
   * never fetches or interprets these fields; it only carries them so a
   * filter predicate supplied via {@link TreeViewer.setFilter} can test them.
   * The full isolate/metadata store stays on the backend — only the fields
   * relevant to the current subtree ride along on its leaves.
   */
  metadata?: Record<string, string | number | null>;
  /**
   * Set by {@link prepareTree} when a clade was truncated because it is
   * collapsed. Lets the layout style it as a collapsed marker rather than a
   * plain leaf, even though it now has no `branchset`.
   */
  collapsed?: boolean;
  /**
   * Back-reference set by {@link prepareTree}: the original tree node this
   * (pruned/cloned) node was produced from. Pruning clones the tree, so a
   * displayed node is not identity-equal to the node in the source tree; this
   * lets operators keyed on the *original* node (e.g. the Expandor/Collapsor's
   * stable-id WeakMap) map a clicked display node back to its source. Absent on
   * un-prepared trees (parser output).
   */
  origin?: NewickNode;
}

export type LayoutMode = "phylogram" | "cladogram";

/**
 * Predicate deciding whether an internal node is currently collapsed. The
 * layout pipeline depends only on this predicate, not on *how* collapse state
 * is stored — so the Expandor/Collapsor operator can key collapse on stable
 * structural IDs (every internal node), not just on `node.name`.
 */
export type IsCollapsed = (node: NewickNode) => boolean;

/** Default predicate: nothing is collapsed. */
export const NEVER_COLLAPSED: IsCollapsed = () => false;

/**
 * Comparator deciding the vertical order of sibling clades. Reordering
 * siblings is a *branch rotation* — a structure-preserving operation that
 * never changes topology, parent/child links, or branch lengths, so it cannot
 * produce an "illegal" tree. The layout engine reads only the resulting order,
 * so cladogram/phylogram x-positioning stays intact. Swap this to change the
 * ordering policy (see {@link orderByName}, {@link orderByNumeric},
 * {@link orderBySizeDesc}).
 */
export type ChildOrder = (a: NewickNode, b: NewickNode) => number;
