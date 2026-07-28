import { describe, expect, it } from "vitest";

import {
  composeLeaf,
  isFilterEmpty,
  matchesFilter,
  parseIsolateTsv,
  totals,
  UNRECORDED,
  valuesOf,
  type FilterSelection,
} from "./isolates";

/**
 * The isolate model (app-side). These tests pin the semantics that the bars and
 * the leaf dimming both depend on: OR within a key, AND across keys, unrecorded
 * values counted but never coloured, and no isolate lost or double-counted.
 */

const KEYS = ["Country", "Source Niche", "Year"];
const MISSING = new Set(["", "NaN", "-"]);

/** A tiny TSV in the shape of the real export: tabs, unquoted commas allowed. */
const TSV = [
  "Name\tCountry\tSource Niche\tYear\tST\tComment",
  "a\tBangladesh\tHuman\t2016\t11\tfoo,bar", // commas in a field survive
  "b\tBangladesh\tEnvironment\t2016\t11\t",
  "c\tPakistan\tHuman\t2017\t11\t",
  "d\tNaN\tHuman\t2016\t11\t", // country not recorded
  "e\tSpain\tHuman\t2016\t42\t",
  "f\tSpain\t-\t\t42\t", // niche and year not recorded
  "g\tSpain\tHuman\t2018\t\t", // no ST ⇒ attaches to no leaf
].join("\n");

const index = parseIsolateTsv(TSV, {
  joinColumn: "ST",
  keys: KEYS,
  missing: MISSING,
});

const filter = (spec: Record<string, string[]>): FilterSelection =>
  new Map(Object.entries(spec).map(([k, v]) => [k, new Set(v)]));

describe("parseIsolateTsv", () => {
  it("indexes isolates by the join column, skipping rows without one", () => {
    expect(index.rows).toBe(6); // g has no ST
    expect(index.byLeaf.get("11")).toHaveLength(4);
    expect(index.byLeaf.get("42")).toHaveLength(2);
    expect(index.byLeaf.has("")).toBe(false);
  });

  it("keeps each isolate as a joint tuple, so AND queries are answerable", () => {
    // The whole reason rows are kept instead of per-key counts.
    const rows = index.byLeaf.get("11")!;
    expect(rows[0]).toEqual(["Bangladesh", "Human", "2016"]);
  });

  it("normalizes every configured missing marker to UNRECORDED", () => {
    const rows = index.byLeaf.get("11")!;
    expect(rows[3][0]).toBe(UNRECORDED); // "NaN"
    const spain = index.byLeaf.get("42")!;
    expect(spain[1][1]).toBe(UNRECORDED); // "-"
    expect(spain[1][2]).toBe(UNRECORDED); // "" (empty field)
  });

  it("counts distinct recorded values per key, excluding unrecorded", () => {
    expect(valuesOf(index, "Country")).toEqual([
      ["Bangladesh", 2],
      ["Spain", 2],
      ["Pakistan", 1],
    ]);
    expect(valuesOf(index, "Source Niche").map(([v]) => v)).toEqual([
      "Human",
      "Environment",
    ]);
  });

  it("interns values, so repeated strings are shared not duplicated", () => {
    const rows = index.byLeaf.get("11")!;
    expect(rows[0][0]).toBe(rows[1][0]); // same "Bangladesh" reference
  });

  it("throws a named error when a configured column is absent", () => {
    expect(() =>
      parseIsolateTsv(TSV, { joinColumn: "ST", keys: ["Nope"], missing: MISSING })
    ).toThrow(/"Nope"/);
    expect(() =>
      parseIsolateTsv(TSV, { joinColumn: "Missing", keys: KEYS, missing: MISSING })
    ).toThrow(/"Missing"/);
  });
});

describe("matchesFilter", () => {
  const row = ["Bangladesh", "Human", "2016"] as const;

  it("passes everything when nothing is selected", () => {
    expect(matchesFilter(row, KEYS, filter({}))).toBe(true);
    expect(matchesFilter(row, KEYS, filter({ Country: [] }))).toBe(true);
  });

  it("ORs values within a key", () => {
    expect(matchesFilter(row, KEYS, filter({ Country: ["Bangladesh", "India"] }))).toBe(true);
    expect(matchesFilter(row, KEYS, filter({ Country: ["India", "Spain"] }))).toBe(false);
  });

  it("ANDs across keys", () => {
    expect(
      matchesFilter(row, KEYS, filter({ Country: ["Bangladesh"], "Source Niche": ["Human"] }))
    ).toBe(true);
    expect(
      matchesFilter(row, KEYS, filter({ Country: ["Bangladesh"], "Source Niche": ["Environment"] }))
    ).toBe(false);
  });

  it("never matches an unrecorded value", () => {
    const unknown = [UNRECORDED, "Human", "2016"] as const;
    expect(matchesFilter(unknown, KEYS, filter({ Country: ["Bangladesh"] }))).toBe(false);
    // …but the isolate is still there when that key isn't constrained.
    expect(matchesFilter(unknown, KEYS, filter({ "Source Niche": ["Human"] }))).toBe(true);
  });
});

describe("isFilterEmpty", () => {
  it("treats absent and empty selections alike", () => {
    expect(isFilterEmpty(filter({}))).toBe(true);
    expect(isFilterEmpty(filter({ Country: [] }))).toBe(true);
    expect(isFilterEmpty(filter({ Country: ["Spain"] }))).toBe(false);
  });
});

describe("totals (legend counts)", () => {
  it("aggregates every leaf, so the legend describes the whole dataset", () => {
    const t = totals(index, "Country", filter({}));
    expect([...t.counts]).toEqual([
      ["Bangladesh", 2],
      ["Pakistan", 1],
      ["Spain", 2],
    ]);
    expect(t.unrecorded).toBe(1);
    expect(t.matched).toBe(6); // every indexed isolate
  });

  it("follows the filter — a legend must not claim rows the filter hid", () => {
    const t = totals(index, "Country", filter({ "Source Niche": ["Human"] }));
    expect([...t.counts]).toEqual([
      ["Bangladesh", 1],
      ["Pakistan", 1],
      ["Spain", 1],
    ]);
    expect(t.matched).toBe(4); // a, c, d, e
  });

  it("conserves: drawn + unrecorded = matched", () => {
    const t = totals(index, "Source Niche", filter({}));
    const drawn = [...t.counts.values()].reduce((s, n) => s + n, 0);
    expect(drawn + t.unrecorded).toBe(t.matched);
  });
});

describe("composeLeaf", () => {
  it("counts the segment key's values, unfiltered", () => {
    const c = composeLeaf(index, "11", "Country", filter({}));
    expect([...c.counts]).toEqual([["Bangladesh", 2], ["Pakistan", 1]]);
    expect(c.unrecorded).toBe(1); // the NaN country
    expect(c.matched).toBe(4);
  });

  it("keeps unrecorded out of the segments but inside the total", () => {
    // Conservation: what is drawn plus what is not equals what matched.
    const c = composeLeaf(index, "11", "Country", filter({}));
    const drawn = [...c.counts.values()].reduce((s, n) => s + n, 0);
    expect(drawn + c.unrecorded).toBe(c.matched);
    expect(drawn).toBe(3);
  });

  it("restricts the composition to matching isolates", () => {
    const c = composeLeaf(index, "11", "Country", filter({ "Source Niche": ["Human"] }));
    // b (Environment) drops out; d still matches on niche but has no country.
    expect([...c.counts]).toEqual([["Bangladesh", 1], ["Pakistan", 1]]);
    expect(c.unrecorded).toBe(1);
    expect(c.matched).toBe(3);
  });

  it("can leave a leaf with a single-value (single-colour) composition", () => {
    const c = composeLeaf(index, "11", "Country", filter({ Year: ["2017"] }));
    expect([...c.counts]).toEqual([["Pakistan", 1]]);
  });

  it("reports nothing matched when the filter excludes every isolate", () => {
    const c = composeLeaf(index, "11", "Country", filter({ Country: ["Spain"] }));
    expect(c.matched).toBe(0);
    expect(c.counts.size).toBe(0);
  });

  it("segments by any configured key, not just the default", () => {
    const c = composeLeaf(index, "11", "Source Niche", filter({}));
    expect([...c.counts]).toEqual([["Human", 3], ["Environment", 1]]);
    expect(c.unrecorded).toBe(0);
  });

  it("returns an empty composition for an unknown leaf or unknown key", () => {
    expect(composeLeaf(index, "nope", "Country", filter({})).matched).toBe(0);
    expect(composeLeaf(index, "11", "Not A Key", filter({})).matched).toBe(0);
  });

  it("counts a leaf whose segment value is entirely unrecorded as matched but uncoloured", () => {
    // ST 42 row f has no niche: segmenting by niche gives one drawn + one not.
    const c = composeLeaf(index, "42", "Source Niche", filter({}));
    expect([...c.counts]).toEqual([["Human", 1]]);
    expect(c.unrecorded).toBe(1);
    expect(c.matched).toBe(2);
  });
});
