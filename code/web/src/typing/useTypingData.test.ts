/**
 * Merging several typing columns into one bar.
 *
 * The user chose this over one bar per column, knowing the cost (2026-09-24).
 * These tests pin the cost down so it stays the one that was chosen rather
 * than drifting into something worse.
 */

import { describe, expect, it } from "vitest";
import { datumFor, mergeColumns, UNRECORDED } from "./useTypingData";

const leaf = (name: string, segments: [string, number][], total?: number) => ({
  leaf: name,
  total: total ?? segments.reduce((sum, [, count]) => sum + count, 0),
  available: total ?? segments.reduce((sum, [, count]) => sum + count, 0),
  segments: segments.map(([value, count]) => ({ value, count })),
});

describe("one column", () => {
  it("leaves the values unqualified, because there is nothing to confuse them with", () => {
    const merged = mergeColumns([
      { column: "Country", leaves: [leaf("1351", [["PT", 3], ["ES", 1]])] },
    ]);
    expect(merged.get("1351")!.segments.map((s) => s.value)).toEqual(["PT", "ES"]);
    expect(merged.get("1351")!.total).toBe(4);
  });

  it("names the blank category rather than colouring an empty label", () => {
    const merged = mergeColumns([{ column: "Country", leaves: [leaf("1351", [["", 2]])] }]);
    expect(merged.get("1351")!.segments[0].value).toBe(UNRECORDED);
  });
});

describe("several columns", () => {
  const merged = () =>
    mergeColumns([
      { column: "Source Niche", leaves: [leaf("1351", [["Environment", 4]])] },
      { column: "Source Type", leaves: [leaf("1351", [["Environment", 4]])] },
    ]);

  it("qualifies values by column, because the same word means different things", () => {
    // "Environment" is both a Source Niche and a Source Type. Merging them
    // into one swatch would claim they are the same category.
    expect(merged().get("1351")!.segments.map((s) => s.value)).toEqual([
      "Source Niche: Environment",
      "Source Type: Environment",
    ]);
  });

  it("counts each isolate once per column, which is the accepted cost", () => {
    // Four isolates, two columns, a bar of eight. Lengths stay comparable
    // between leaves; they stop meaning "isolates". The legend says so.
    expect(merged().get("1351")!.total).toBe(8);
  });

  it("keeps `available` as the real isolate count, not a sum", () => {
    // `available` is "isolates before filtering" — a property of the leaf, not
    // of how many columns are on screen, so summing it would be wrong.
    expect(merged().get("1351")!.available).toBe(4);
  });

  it("carries a leaf that only one column knows about", () => {
    const partial = mergeColumns([
      { column: "Country", leaves: [leaf("1351", [["PT", 2]]), leaf("6555", [["ES", 1]])] },
      { column: "Continent", leaves: [leaf("1351", [["Europe", 2]])] },
    ]);
    expect([...partial.keys()].sort()).toEqual(["1351", "6555"]);
    expect(partial.get("6555")!.segments).toHaveLength(1);
  });

  it("drops empty segments rather than colouring a zero", () => {
    const merged = mergeColumns([
      { column: "Country", leaves: [leaf("1351", [["PT", 2], ["ES", 0]])] },
    ]);
    expect(merged.get("1351")!.segments).toHaveLength(1);
  });
});

describe("datumFor", () => {
  it("gives nothing for a leaf with no isolates", () => {
    // Handed an empty datum, the library keys the bar by the leaf identifier —
    // which turned sequence types into colour categories of their own.
    expect(datumFor(leaf("582", [], 0))).toBeUndefined();
    expect(datumFor(undefined)).toBeUndefined();
  });

  it("passes segments through for a leaf that has them", () => {
    const datum = datumFor(leaf("1351", [["PT", 3]]));
    expect(datum).toEqual({ total: 3, segments: [{ key: "PT", value: 3 }] });
  });
});
