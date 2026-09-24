/**
 * Typing data for the leaves currently on screen.
 *
 * **Only for what is displayed.** A slice shows tens of leaves out of tens of
 * thousands, and the composition of the rest is not needed to draw it — so the
 * request carries the visible sequence types and nothing else. This is the
 * bargain the tree slicing already makes, applied to the metadata.
 *
 * **More than one column can be shown at once**, and the segments are merged
 * into one bar (user's choice, 2026-09-24). That has a consequence worth being
 * explicit about rather than hiding: the backend segments by one column per
 * request, and every isolate appears in every column, so an isolate is counted
 * once *per selected column*. Two columns make a leaf's bar twice as long as
 * its isolate count. Bar lengths therefore stay comparable **between leaves**
 * but no longer read as "how many isolates"; `inflation` carries the factor so
 * the legend and tooltips can say so.
 */

import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { LeafComposition, ValueCount } from "../api/types";
import type { SliceTree } from "../tree/fromSlice";

/** "Not recorded" as one category, whatever the export wrote. */
export const UNRECORDED = "(not recorded)";

export interface TypingData {
  /** Merged segments by leaf label, ready for the library's bar charts. */
  byLeaf: Map<string, LeafComposition>;
  /** Every category present, so a legend is complete before a bar is drawn. */
  categories: string[];
  /** The columns currently shown. */
  segmentKeys: string[];
  /** Every column that can segment. */
  keys: string[];
  /** How many times each isolate is counted — one per selected column. */
  inflation: number;
  loading: boolean;
  error: string | null;
}

const EMPTY: TypingData = {
  byLeaf: new Map(),
  categories: [],
  segmentKeys: [],
  keys: [],
  inflation: 1,
  loading: false,
  error: null,
};

/**
 * The key a segment is coloured by.
 *
 * Qualified by its column when more than one is shown, because values collide
 * across columns — "Environment" is both a Source Niche and a Source Type, and
 * merging them into one swatch would claim they are the same thing. With a
 * single column the prefix is noise, so it is left off.
 */
function segmentKey(column: string, value: string, qualify: boolean): string {
  const name = value || UNRECORDED;
  return qualify ? `${column}: ${name}` : name;
}

export function datumFor(composition: LeafComposition | undefined) {
  if (!composition || composition.total <= 0) return undefined;
  const segments = composition.segments
    .filter((segment) => segment.count > 0)
    .map((segment) => ({ key: segment.value, value: segment.count }));
  // A leaf with no segments gets no datum: handed one, the library falls back
  // to keying the bar by the *leaf identifier*, which turned sequence types
  // into colour categories of their own.
  if (segments.length === 0) return undefined;
  return { total: composition.total, segments };
}

/** Leaf labels in a slice — the real ones, not the clades folded into wedges. */
export function displayedLeafLabels(tree: SliceTree | null): string[] {
  if (!tree) return [];
  const labels: string[] = [];
  for (const storedId of tree.leaves) {
    const node = tree.byStoredId.get(storedId);
    const label = node?.metadata?.label;
    if (typeof label === "string" && label && label !== "_") labels.push(label);
  }
  return labels;
}

/** Combine one response per column into a single composition per leaf. */
export function mergeColumns(
  responses: { column: string; leaves: LeafComposition[] }[],
): Map<string, LeafComposition> {
  const qualify = responses.length > 1;
  const merged = new Map<string, LeafComposition>();

  for (const { column, leaves } of responses) {
    for (const leaf of leaves) {
      const existing = merged.get(leaf.leaf);
      const segments: ValueCount[] = leaf.segments
        .filter((segment) => segment.count > 0)
        .map((segment) => ({
          value: segmentKey(column, segment.value, qualify),
          count: segment.count,
        }));
      if (!existing) {
        merged.set(leaf.leaf, { ...leaf, segments });
        continue;
      }
      merged.set(leaf.leaf, {
        leaf: leaf.leaf,
        // Summed across columns, which is the inflation this returns openly.
        total: existing.total + leaf.total,
        available: Math.max(existing.available, leaf.available),
        segments: [...existing.segments, ...segments],
      });
    }
  }
  return merged;
}

export function useTypingData(
  isolateSet: string | null,
  tree: SliceTree | null,
  enabled: boolean,
  segmentKeys: string[],
): TypingData {
  const [keys, setKeys] = useState<string[]>([]);
  const [byLeaf, setByLeaf] = useState<Map<string, LeafComposition>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labels = useMemo(() => displayedLeafLabels(tree), [tree]);
  const labelKey = labels.join(",");
  const columnKey = segmentKeys.join(",");

  // Which columns can segment. Once per isolate set, not per slice.
  useEffect(() => {
    if (!enabled || !isolateSet) return;
    let live = true;
    api
      .isolateKeys(isolateSet)
      .then((info) => {
        if (live) setKeys(info.facets.filter((f) => f.segmentable).map((f) => f.name));
      })
      .catch(() => live && setKeys([]));
    return () => {
      live = false;
    };
  }, [enabled, isolateSet]);

  useEffect(() => {
    if (!enabled || !isolateSet || segmentKeys.length === 0 || labels.length === 0) {
      setByLeaf(new Map());
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    // One request per column: the API segments by a single column at a time,
    // which is the right shape for it — the merging is a presentation choice
    // and belongs here.
    Promise.all(
      segmentKeys.map((column) =>
        api
          .compositions(isolateSet, { leaves: labels, segment_by: column })
          .then((response) => ({ column, leaves: response.leaves })),
      ),
    )
      .then((responses) => {
        if (!live) return;
        setByLeaf(mergeColumns(responses));
        setLoading(false);
      })
      .catch((failed: unknown) => {
        if (!live) return;
        setError(failed instanceof ApiError ? failed.message : String(failed));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, isolateSet, columnKey, labelKey, labels, segmentKeys]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const composition of byLeaf.values()) {
      for (const segment of composition.segments) {
        if (segment.count > 0) seen.add(segment.value);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [byLeaf]);

  // Memoised: consumers put this in effect dependencies, and a fresh object
  // every render made such an effect run every render — one that also set
  // state looped until the page died.
  return useMemo(
    () =>
      enabled
        ? {
            byLeaf,
            categories,
            segmentKeys,
            keys,
            inflation: Math.max(1, segmentKeys.length),
            loading,
            error,
          }
        : EMPTY,
    [enabled, byLeaf, categories, segmentKeys, keys, loading, error],
  );
}
