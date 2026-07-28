import { describe, expect, it } from "vitest";
import type { NewickNode } from "./types";
import { buildGraph, BRANCH_COLOR, type LayoutNode } from "./layout";
import { orderByName } from "./model";

/** root(a, b(c, d)) — asymmetric, so depth and distance differ per tip. */
function tree(): NewickNode {
  return {
    name: "root",
    branchset: [
      { name: "a", length: 5 },
      {
        name: "b",
        length: 1,
        branchset: [
          { name: "c", length: 1 },
          { name: "d", length: 1 },
        ],
      },
    ],
  };
}

const never = () => false;

function leaves(nodeMap: Map<string, LayoutNode>): LayoutNode[] {
  return [...nodeMap.values()].filter((n) => n.isLeaf);
}

describe("buildGraph — graph construction", () => {
  it("returns a graph plus a lookup of real nodes", () => {
    const { graph, nodeMap } = buildGraph(tree(), never, 100, "cladogram");
    expect(graph.order).toBeGreaterThan(0);
    expect(nodeMap.size).toBeGreaterThan(0);
  });

  it("excludes invisible connector nodes from the node map", () => {
    // v_*/h_* helpers exist in the graph to draw the rectangular elbows, but
    // they are not real tree nodes and operators must not see them.
    const { graph, nodeMap } = buildGraph(tree(), never, 100, "cladogram");
    for (const id of nodeMap.keys()) {
      expect(id.startsWith("v_")).toBe(false);
      expect(id.startsWith("h_")).toBe(false);
    }
    expect(graph.order).toBeGreaterThan(nodeMap.size); // connectors do exist
  });

  it("maps every layout node back to its source tree node", () => {
    const { nodeMap } = buildGraph(tree(), never, 100, "cladogram");
    for (const n of nodeMap.values()) expect(n.source).toBeDefined();
  });

  it("gives every edge a nodeId so operators can style connector edges", () => {
    // Connector endpoints are invisible helpers, so the edge carries the real
    // node it visually belongs to — how comparison coloring reaches branches.
    const { graph } = buildGraph(tree(), never, 100, "cladogram");
    graph.forEachEdge((_e, attrs) => {
      expect(attrs.nodeId).toBeTruthy();
    });
  });

  it("colors branches with the default branch color", () => {
    const { graph } = buildGraph(tree(), never, 100, "cladogram");
    graph.forEachEdge((_e, attrs) => expect(attrs.color).toBe(BRANCH_COLOR));
  });
});

describe("buildGraph — terminal alignment", () => {
  it("aligns every tip to a common x so bars share a baseline", () => {
    const { nodeMap } = buildGraph(tree(), never, 100, "cladogram");
    const xs = new Set(leaves(nodeMap).map((n) => n.x));
    expect(xs.size).toBe(1); // all tips in one column
  });

  it("aligns tips in phylogram mode too, despite differing distances", () => {
    const { nodeMap } = buildGraph(tree(), never, 100, "phylogram");
    const xs = new Set(leaves(nodeMap).map((n) => n.x));
    expect(xs.size).toBe(1);
  });

  it("gives each leaf a distinct y", () => {
    const { nodeMap } = buildGraph(tree(), never, 100, "cladogram");
    const ys = leaves(nodeMap).map((n) => n.y);
    expect(new Set(ys).size).toBe(ys.length);
  });
});

describe("buildGraph — layout modes", () => {
  it("cladogram places internal nodes by depth", () => {
    const { nodeMap } = buildGraph(tree(), never, 100, "cladogram");
    const root = nodeMap.get("named_root")!;
    const b = nodeMap.get("named_b")!;
    expect(root.x).toBeLessThan(b.x); // deeper node sits further right
  });

  it("phylogram places internal nodes by cumulative branch length", () => {
    const clad = buildGraph(tree(), never, 100, "cladogram").nodeMap.get("named_b")!;
    const phylo = buildGraph(tree(), never, 100, "phylogram").nodeMap.get("named_b")!;
    // Same node, different x rule — the two modes must not agree by accident.
    expect(phylo.x).not.toBe(clad.x);
  });
});

describe("buildGraph — reflection", () => {
  it("mirrors x for every node when reflected", () => {
    const normal = buildGraph(tree(), never, 100, "cladogram", true, undefined, false);
    const mirrored = buildGraph(tree(), never, 100, "cladogram", true, undefined, true);

    for (const [id, node] of normal.nodeMap) {
      expect(mirrored.nodeMap.get(id)!.x).toBeCloseTo(-node.x, 6);
    }
  });

  it("leaves y untouched, so reflection is horizontal only", () => {
    const normal = buildGraph(tree(), never, 100, "cladogram", true, undefined, false);
    const mirrored = buildGraph(tree(), never, 100, "cladogram", true, undefined, true);

    for (const [id, node] of normal.nodeMap) {
      expect(mirrored.nodeMap.get(id)!.y).toBeCloseTo(node.y, 6);
    }
  });
});

describe("buildGraph — collapse and visibility", () => {
  it("renders a collapsed clade as a terminal, flagged distinctly", () => {
    const { nodeMap } = buildGraph(
      tree(),
      (n) => n.name === "b",
      100,
      "cladogram"
    );
    const collapsed = [...nodeMap.values()].find((n) => n.isCollapsed)!;

    expect(collapsed).toBeDefined();
    expect(collapsed.isLeaf).toBe(false); // collapsed != leaf, so it stays togglable
    expect(collapsed.children).toHaveLength(0); // ...but draws as a tip
  });

  it("hides the descendants of a collapsed clade", () => {
    const open = buildGraph(tree(), never, 100, "cladogram").nodeMap;
    const folded = buildGraph(tree(), (n) => n.name === "b", 100, "cladogram").nodeMap;

    expect(open.has("named_c")).toBe(true);
    expect(folded.has("named_c")).toBe(false);
  });

  it("draws internal nodes at size 0 when hidden, keeping them hit-testable in the map", () => {
    const { graph, nodeMap } = buildGraph(tree(), never, 100, "cladogram", true);
    expect(graph.getNodeAttribute("named_root", "size")).toBe(0);
    expect(nodeMap.has("named_root")).toBe(true); // still addressable by operators
  });

  it("gives internal nodes a visible size when not hidden", () => {
    const { graph } = buildGraph(tree(), never, 100, "cladogram", false);
    expect(graph.getNodeAttribute("named_root", "size")).toBeGreaterThan(0);
  });
});

describe("buildGraph — budget and ordering", () => {
  it("respects the maxNodes leaf budget", () => {
    const { nodeMap } = buildGraph(tree(), never, 2, "cladogram");
    expect(leaves(nodeMap).length).toBeLessThanOrEqual(2);
  });

  it("orders tips top-to-bottom by the child order", () => {
    const { nodeMap } = buildGraph(
      tree(),
      never,
      100,
      "cladogram",
      true,
      undefined,
      false,
      orderByName
    );
    // y descends as leaves are laid out, so sorting by -y gives display order.
    const names = leaves(nodeMap)
      .sort((p, q) => q.y - p.y)
      .map((n) => n.label);
    expect(names).toEqual(["a", "c", "d"]);
  });
});
