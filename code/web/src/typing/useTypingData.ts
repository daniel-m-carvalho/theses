/**
 * Typing data for the leaves currently on screen.
 *
 * **Only for what is displayed.** A slice shows tens of leaves out of tens of
 * thousands, and the composition of the rest is not needed to draw it — so the
 * request carries the visible sequence types and nothing else. This is the
 * same bargain the tree slicing makes, applied to the metadata: fetch what is
 * on screen, not what exists.
 *
 * Refetched when the slice changes, because a different slice shows different
 * leaves.
 */

import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { LeafComposition } from "../api/types";
import type { SliceTree } from "../tree/fromSlice";

export interface TypingData {
  /** Segment breakdown by leaf label, for the library's data provider. */
  byLeaf: Map<string, LeafComposition>;
  /** Every category present, so a legend can be drawn before any bar is. */
  categories: string[];
  segmentBy: string;
  keys: string[];
  loading: boolean;
  error: string | null;
}

const EMPTY: TypingData = {
  byLeaf: new Map(),
  categories: [],
  segmentBy: "",
  keys: [],
  loading: false,
  error: null,
};

/** "Not recorded" as one category, whatever the export wrote. */
export const UNRECORDED = "";

/**
 * A composition as the library's bar charts want it, or nothing.
 *
 * Two things this is careful about, both learned from the legend it feeds:
 *
 * **A leaf with no segments gets no datum.** Given one, `datumSegments` falls
 * back to keying the bar by the *leaf identifier*, so leaves with no typing
 * data at all turned into their own colour categories — the legend listed
 * sequence types 582 and 9102 as values of "Source Niche".
 *
 * **Null and blank collapse to one key.** The export writes both for "not
 * recorded"; left alone they became two identically-labelled swatches in
 * different colours.
 */
export function datumFor(composition: LeafComposition | undefined) {
  if (!composition || composition.total <= 0) return undefined;
  const segments = composition.segments
    .filter((segment) => segment.count > 0)
    .map((segment) => ({
      key: typeof segment.value === "string" && segment.value ? segment.value : UNRECORDED,
      value: segment.count,
    }));
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

export function useTypingData(
  isolateSet: string | null,
  tree: SliceTree | null,
  enabled: boolean,
  segmentBy: string | null,
): TypingData {
  const [keys, setKeys] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string>("");
  const [byLeaf, setByLeaf] = useState<Map<string, LeafComposition>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labels = useMemo(() => displayedLeafLabels(tree), [tree]);
  const labelKey = labels.join(",");

  // Which columns can segment. Fetched once per isolate set, not per slice.
  useEffect(() => {
    if (!enabled || !isolateSet) return;
    let live = true;
    api
      .isolateKeys(isolateSet)
      .then((info) => {
        if (!live) return;
        const segmentable = info.facets.filter((f) => f.segmentable).map((f) => f.name);
        setKeys(segmentable);
        setChosen((current) => current || segmentBy || segmentable[0] || "");
      })
      .catch(() => live && setKeys([]));
    return () => {
      live = false;
    };
  }, [enabled, isolateSet, segmentBy]);

  const active = segmentBy || chosen;

  useEffect(() => {
    if (!enabled || !isolateSet || !active || labels.length === 0) {
      setByLeaf(new Map());
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .compositions(isolateSet, { leaves: labels, segment_by: active })
      .then((response) => {
        if (!live) return;
        setByLeaf(new Map(response.leaves.map((leaf) => [leaf.leaf, leaf])));
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
  }, [enabled, isolateSet, active, labelKey, labels]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const composition of byLeaf.values()) {
      for (const segment of composition.segments) {
        // Blank and null are "not recorded". They are kept as a category
        // because the isolates behind them are real and counted, but they are
        // normalised to one key so the legend does not show two.
        if (segment.count > 0) {
          seen.add(
            typeof segment.value === "string" && segment.value ? segment.value : UNRECORDED,
          );
        }
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [byLeaf]);

  // Memoised because consumers put this in effect dependencies. Returning a
  // fresh object every render made such an effect run every render, and one
  // that also set state looped until the page died.
  return useMemo(
    () => (enabled ? { byLeaf, categories, segmentBy: active, keys, loading, error } : EMPTY),
    [enabled, byLeaf, categories, active, keys, loading, error],
  );
}
