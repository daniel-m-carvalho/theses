/**
 * Comparison values, addressed the way the library asks for them.
 *
 * The API sends values positionally, aligned index-for-index with the slice's
 * topology — no join. The library's comparison operator asks by **node key**
 * (a node's `name`). This bridges the two, and is the only place that
 * translation happens.
 */

import type { ComparisonValues } from "../api/types";
import type { SliceTree } from "./fromSlice";

export interface Gradient {
  /** Similarity in [0, 1] for a stored id, or undefined where it has none. */
  similarityOf: (storedId: number) => number | undefined;
  /** The corresponding node in the other tree, by stored id. */
  correspondingTo: (storedId: number) => number | undefined;
}

export function gradientFrom(
  tree: SliceTree,
  values: ComparisonValues | null | undefined,
): Gradient {
  if (!values) {
    return { similarityOf: () => undefined, correspondingTo: () => undefined };
  }

  // Keyed by stored id, never by name. The library generates its own Sigma
  // keys and a node's name is neither unique nor stable, so the backend's
  // pre-order index is the only identifier both sides agree on.
  const similarity = new Map<number, number>();
  for (const [storedId, at] of tree.indexOfStoredId) {
    const value = values.similarity[at];
    // null is "this node has no counterpart" — JSON has no NaN, so the API
    // sends null rather than a sentinel that would look like a real value.
    if (value !== null && value !== undefined) similarity.set(storedId, value);
  }

  const corresponds = new Map<number, number>();
  for (const [storedId, at] of tree.indexOfStoredId) {
    const other = values.corresponds[at];
    if (other !== null && other !== undefined) corresponds.set(storedId, other);
  }

  return {
    similarityOf: (storedId) => similarity.get(storedId),
    correspondingTo: (storedId) => corresponds.get(storedId),
  };
}
