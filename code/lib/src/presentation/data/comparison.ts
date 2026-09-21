import type { NewickNode } from "../tree/types";
import { getSubtreeLeaves } from "../tree/model";

/**
 * Contract for presenting backend-computed tree differences.
 *
 * The backend computes a comparison metric (RF, BCN/Jaccard, weighted RF, …)
 * and sends, per node/branch, a numeric difference/similarity value. The
 * library does not compute the metric — it only presents it. Following the
 * phylo.io convention, an edge is colored by the value stored on its **child
 * node** (the branch represents that node's clade / bipartition), so values
 * are keyed by a node, whether the metric is conceptually "per edge" or
 * "per leaf".
 *
 * A node is identified by a **key** computed from the node. Two keyers are
 * provided; the operator's `keyOf` is configurable so the backend can key by
 * whichever it uses:
 *  - {@link keyByClade} — canonical leaf-set (bipartition). Robust for internal
 *    branches and standard for topology metrics; works for unnamed internals.
 *  - {@link keyByName} — the node's own name (leaf id / named clade).
 */
export type NodeKeyOf = (node: NewickNode) => string;

/** Per-key comparison value (e.g. similarity in [0,1], or a distance). */
export type ComparisonValues = Map<string, number>;

/** Function form of {@link ComparisonValues}; return undefined for "no data". */
export type ComparisonValueProvider = (key: string, node: NewickNode) => number | undefined;

/**
 * Membership-mode input: the set of node keys that DIFFER between the two
 * trees. Some metrics report not a per-node magnitude but a partition — which
 * nodes/clades (leaves included) are shared vs which differ. Nodes whose key is
 * in this set are painted with the "different" color; all others with the
 * "equal" color. Complements {@link ComparisonValues} (used by the gradient
 * presentation); a backend may supply the value, the set, or both.
 */
export type DifferenceSet = Set<string>;

/** Function form of {@link DifferenceSet}; return true when the node differs. */
export type DifferencePredicate = (key: string, node: NewickNode) => boolean;

/**
 * Cross-tree node correspondence for navigation: maps a node key in *this*
 * tree to the corresponding node key in the *other* tree (e.g. phylo.io's
 * best-corresponding-node result). When omitted, the same key is assumed to
 * correspond (exact clade / name match).
 */
export type CorrespondenceMap = Map<string, string>;

/** Key a node by its canonical leaf-set (sorted leaf names joined by '|'). */
export const keyByClade: NodeKeyOf = (node) =>
  getSubtreeLeaves(node)
    .map((l) => l.name)
    .sort()
    .join("|");

/** Key a node by its own name (empty string when unnamed). */
export const keyByName: NodeKeyOf = (node) => node.name ?? "";
