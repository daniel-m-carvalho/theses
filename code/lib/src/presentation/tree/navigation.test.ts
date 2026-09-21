import { describe, expect, it } from "vitest";
import type { NewickNode } from "./types";
import { buildGraph, type LayoutNode } from "./layout";
import { leafNamesOf, mrcaId } from "./navigation";

/**
 * `leafNamesOf` / `mrcaId` turn a *selection* (graph-node ids) back into tree
 * structure. They read the real layout, so these build an actual graph via
 * `buildGraph` rather than hand-rolling a node map — the id scheme, the
 * `origin` back-reference, and collapsed-tip pruning are exactly what's under
 * test, and only the real pipeline produces them.
 */

/** root(a, b(c, d)) — ids come out as `named_<name>`. */
function namedTree(): NewickNode {
  return {
    name: "root",
    branchset: [
      { name: "a", length: 1 },
      { name: "b", length: 1, branchset: [{ name: "c", length: 1 }, { name: "d", length: 1 }] },
    ],
  };
}

/** Every internal node's id that is *not* the root (has a parent in the map). */
function internalId(nodeMap: Map<string, LayoutNode>, label: string): string {
  for (const n of nodeMap.values()) if (!n.isLeaf && n.label === label) return n.id;
  throw new Error(`no internal node labelled ${label}`);
}

describe("leafNamesOf", () => {
  it("returns a selected leaf as itself", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(leafNamesOf(nodeMap, ["named_a"])).toEqual(["a"]);
  });

  it("expands a selected clade to every leaf under it", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(leafNamesOf(nodeMap, [internalId(nodeMap, "b")]).sort()).toEqual(["c", "d"]);
  });

  it("expands the root to the whole leaf set", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(leafNamesOf(nodeMap, [internalId(nodeMap, "root")]).sort()).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("unfolds a COLLAPSED clade to its hidden leaves, not the marker", () => {
    // The whole point: a collapsed clade renders as a single tip, but the
    // selection should still resolve to the isolates it hides (via `origin`).
    const { nodeMap } = buildGraph(namedTree(), (n) => n.name === "b");
    const marker = [...nodeMap.values()].find((n) => n.isCollapsed)!;
    expect(marker.source.branchset).toBeUndefined(); // really drawn as a tip
    expect(leafNamesOf(nodeMap, [marker.id]).sort()).toEqual(["c", "d"]);
  });

  it("de-duplicates when a clade and one of its leaves are both selected", () => {
    const { nodeMap } = buildGraph(namedTree());
    const out = leafNamesOf(nodeMap, [internalId(nodeMap, "b"), "named_c"]);
    expect(out.sort()).toEqual(["c", "d"]); // c appears once
  });

  it("skips unknown ids (and connectors, which are absent from the map)", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(leafNamesOf(nodeMap, ["v_nope", "named_a"])).toEqual(["a"]);
  });

  it("is empty for an empty selection", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(leafNamesOf(nodeMap, [])).toEqual([]);
  });
});

describe("mrcaId", () => {
  it("returns the single id for a one-node selection", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(mrcaId(nodeMap, ["named_c"])).toBe("named_c");
  });

  it("finds the immediate parent clade of two sibling leaves", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(mrcaId(nodeMap, ["named_c", "named_d"])).toBe(internalId(nodeMap, "b"));
  });

  it("climbs to the root when leaves span different clades", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(mrcaId(nodeMap, ["named_a", "named_d"])).toBe(internalId(nodeMap, "root"));
  });

  it("is order-independent", () => {
    const { nodeMap } = buildGraph(namedTree());
    const a = mrcaId(nodeMap, ["named_a", "named_c", "named_d"]);
    const b = mrcaId(nodeMap, ["named_d", "named_a", "named_c"]);
    expect(a).toBe(b);
    expect(a).toBe(internalId(nodeMap, "root"));
  });

  it("ignores unknown ids and returns null when nothing is known", () => {
    const { nodeMap } = buildGraph(namedTree());
    expect(mrcaId(nodeMap, ["ghost", "named_c"])).toBe("named_c");
    expect(mrcaId(nodeMap, ["ghost"])).toBeNull();
    expect(mrcaId(nodeMap, [])).toBeNull();
  });
});
