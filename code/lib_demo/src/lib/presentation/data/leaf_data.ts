import type { NewickNode } from "../tree/types";

/**
 * Per-leaf data supplied by a backend — whatever quantity the project attaches
 * to a tip (isolate counts, read depth, speaker counts…). The library treats it
 * as an opaque magnitude and never names the unit; the app supplies that wording
 * via `tooltipOf`.
 *
 * Two shapes are supported, so a project can start simple and grow:
 *  - **Single value** — set `total` only (e.g. a plain count). Rendered
 *    as one bar segment.
 *  - **Composition** — set `segments` (a breakdown by category, e.g. by region
 *    or serotype). Rendered as a stacked bar; the total length reflects the sum
 *    of segment values (or `total` if given explicitly).
 *
 * Colors are normally assigned semantically from the category key via the
 * shared color scale (so the same category is the same color in every tree); a
 * `segment.color` may override that for a specific segment.
 */
export interface LeafSegment {
  /** Category key (e.g. "PT", "serotypeX"). Drives the semantic color. */
  key: string;
  /** Magnitude of this segment (e.g. how many items fall in this category). */
  value: number;
  /** Optional explicit color override; otherwise the shared scale colors `key`. */
  color?: string;
}

export interface LeafDatum {
  /**
   * Total magnitude (bar length). Optional when `segments` is present — it then
   * defaults to the sum of segment values.
   */
  total?: number;
  /** Composition breakdown. Omit for a single-value bar. */
  segments?: LeafSegment[];
}

/**
 * Resolves the {@link LeafDatum} for a leaf, keyed by its identifier
 * (`leaf.category ?? leaf.name`). Return `undefined` to fall through to the
 * next data source. This is the backend-injection seam: the app fetches its data
 * and supplies it as a Map or this function — the library never fetches.
 */
export type LeafDataProvider = (
  identifier: string,
  leaf: NewickNode
) => LeafDatum | undefined;

/** Sum of a datum's segment values, or its explicit total. */
export function datumTotal(datum: LeafDatum): number {
  if (typeof datum.total === "number") return Math.max(0, datum.total);
  return (datum.segments ?? []).reduce((s, seg) => s + Math.max(0, seg.value), 0);
}

/**
 * Normalize a datum to a non-empty segment list. A single-value datum becomes
 * one segment keyed by the leaf identifier (so it still gets a semantic color).
 */
export function datumSegments(datum: LeafDatum, identifier: string): LeafSegment[] {
  if (datum.segments && datum.segments.length > 0) {
    return datum.segments.filter((s) => s.value > 0);
  }
  return [{ key: identifier, value: datumTotal(datum) }];
}
