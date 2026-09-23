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
  /** Similarity in [0, 1] for a node key, or undefined where it has none. */
  valueFor: (key: string) => number | undefined;
  /** The corresponding node in the other tree, by stored id. */
  correspondingTo: (storedId: number) => number | undefined;
}

export function gradientFrom(
  tree: SliceTree,
  values: ComparisonValues | null | undefined,
): Gradient {
  if (!values) {
    return { valueFor: () => undefined, correspondingTo: () => undefined };
  }

  const byKey = new Map<string, number>();
  for (const [name, storedId] of tree.storedIdOfName) {
    const at = tree.indexOfStoredId.get(storedId);
    if (at === undefined) continue;
    const similarity = values.similarity[at];
    // null is "this node has no counterpart" — JSON has no NaN, so the API
    // sends null rather than a sentinel that would look like a real value.
    if (similarity !== null && similarity !== undefined) byKey.set(name, similarity);
  }

  const corresponds = new Map<number, number>();
  for (const [storedId, at] of tree.indexOfStoredId) {
    const other = values.corresponds[at];
    if (other !== null && other !== undefined) corresponds.set(storedId, other);
  }

  return {
    valueFor: (key) => byKey.get(key),
    correspondingTo: (storedId) => corresponds.get(storedId),
  };
}
