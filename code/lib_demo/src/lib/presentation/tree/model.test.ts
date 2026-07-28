import { describe, expect, it } from "vitest";
import type { NewickNode } from "./types";
import {
  countLeaves,
  maxDepth,
  orderByName,
  prepareTree,
  rerootTree,
  subtreeSize,
} from "./model";

/** Build a small named tree: root(a, b(c, d)). */
function sampleTree(): NewickNode {
  return {
    name: "root",
    branchset: [
      { name: "a", length: 1 },
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

/** A balanced binary tree of the given depth; leaves are named L<index>. */
function binaryTree(depth: number, prefix = "n"): NewickNode {
  if (depth === 0) return { name: `L${prefix}`, length: 1 };
  return {
    name: "",
    length: 1,
    branchset: [binaryTree(depth - 1, `${prefix}0`), binaryTree(depth - 1, `${prefix}1`)],
  };
}

const never = () => false;

describe("metrics", () => {
  it("counts leaves, not nodes", () => {
    expect(countLeaves(sampleTree())).toBe(3);
    expect(subtreeSize(sampleTree())).toBe(3);
  });

  it("counts a lone leaf as one", () => {
    expect(countLeaves({ name: "solo" })).toBe(1);
  });

  it("measures depth in edges from the root", () => {
    expect(maxDepth(sampleTree())).toBe(2);
    expect(maxDepth({ name: "solo" })).toBe(0);
    expect(maxDepth(binaryTree(4))).toBe(4);
  });
});

describe("prepareTree — origin back-reference", () => {
  // Regression guard: pruning CLONES the tree, so a displayed node is never
  // identity-equal to its source. Operators (collapse, clade shapes, navigator)
  // map back via `origin`. When this was missing, collapse silently never
  // worked — the toggle looked up a clone in a WeakMap keyed on originals.
  it("stamps origin on a leaf pointing at the source node", () => {
    const tree = sampleTree();
    const prepared = prepareTree(tree, never, 100, orderByName)!;
    const leafA = prepared.branchset!.find((n) => n.name === "a")!;
    expect(leafA.origin).toBe(tree.branchset![0]);
  });

  it("stamps origin on internal nodes", () => {
    const tree = sampleTree();
    const prepared = prepareTree(tree, never, 100, orderByName)!;
    expect(prepared.origin).toBe(tree);
  });

  it("stamps origin on a collapsed clade and makes it terminal", () => {
    const tree = sampleTree();
    const b = tree.branchset![1];
    const prepared = prepareTree(tree, (n) => n.name === "b", 100, orderByName)!;

    const collapsedB = prepared.branchset!.find((n) => n.name === "b")!;
    expect(collapsedB.collapsed).toBe(true);
    expect(collapsedB.branchset).toBeUndefined(); // renders as a tip
    expect(collapsedB.origin).toBe(b); // ...but still resolves to the real clade
  });

  it("gives every prepared node an origin in the source tree", () => {
    const tree = binaryTree(3);
    const prepared = prepareTree(tree, never, 100, orderByName)!;

    const sources = new Set<NewickNode>();
    (function collect(n: NewickNode) {
      sources.add(n);
      (n.branchset ?? []).forEach(collect);
    })(tree);

    (function check(n: NewickNode) {
      expect(n.origin).toBeDefined();
      expect(sources.has(n.origin!)).toBe(true);
      (n.branchset ?? []).forEach(check);
    })(prepared);
  });

  it("does not mutate the source tree", () => {
    const tree = sampleTree();
    prepareTree(tree, (n) => n.name === "b", 2, orderByName);
    expect(tree.origin).toBeUndefined();
    expect(tree.branchset![1].collapsed).toBeUndefined();
    expect(countLeaves(tree)).toBe(3);
  });

  it("carries metadata onto the cloned display node", () => {
    // Regression: the clone copied name/length/category but dropped `metadata`,
    // so every *rendered* leaf arrived with none and the viewer's metadata
    // filter (README §8.2) matched nothing — the feature was inert on a real
    // tree while unit tests calling passesFilter on un-pruned nodes passed.
    const tree: NewickNode = {
      name: "root",
      branchset: [
        { name: "a", metadata: { country: "PT", year: 2019 } },
        { name: "b" },
      ],
    };
    const prepared = prepareTree(tree, () => false, 100, orderByName)!;
    const a = prepared.branchset!.find((n) => n.name === "a")!;

    expect(a.metadata).toEqual({ country: "PT", year: 2019 });
  });

  it("carries metadata through a collapsed clade", () => {
    const tree: NewickNode = {
      name: "root",
      branchset: [
        { name: "a" },
        {
          name: "b",
          metadata: { source: "clinical" },
          branchset: [{ name: "c" }, { name: "d" }],
        },
      ],
    };
    const prepared = prepareTree(tree, (n) => n.name === "b", 100, orderByName)!;
    const b = prepared.branchset!.find((n) => n.name === "b")!;

    expect(b.collapsed).toBe(true);
    expect(b.metadata).toEqual({ source: "clinical" });
  });
});

describe("prepareTree — leaf budget", () => {
  it("keeps the whole tree when the budget is ample", () => {
    const prepared = prepareTree(binaryTree(3), never, 100, orderByName)!;
    expect(countLeaves(prepared)).toBe(8);
  });

  it("never exceeds the leaf budget", () => {
    for (const budget of [1, 2, 3, 5, 8]) {
      const prepared = prepareTree(binaryTree(4), never, budget, orderByName)!;
      expect(countLeaves(prepared)).toBeLessThanOrEqual(budget);
    }
  });

  it("returns null for a non-positive budget", () => {
    expect(prepareTree(sampleTree(), never, 0, orderByName)).toBeNull();
  });

  it("counts a collapsed clade as a single leaf against the budget", () => {
    // b collapses to one tip, so root(a, b) is 2 leaves and fits a budget of 2.
    const prepared = prepareTree(sampleTree(), (n) => n.name === "b", 2, orderByName)!;
    expect(countLeaves(prepared)).toBe(2);
  });
});

describe("prepareTree — ordering", () => {
  it("orders siblings by name without changing topology", () => {
    const tree: NewickNode = {
      name: "root",
      branchset: [{ name: "z" }, { name: "m" }, { name: "a" }],
    };
    const prepared = prepareTree(tree, never, 100, orderByName)!;
    expect(prepared.branchset!.map((n) => n.name)).toEqual(["a", "m", "z"]);
    expect(countLeaves(prepared)).toBe(3); // same leaves, only rotated
  });
});

describe("rerootTree", () => {
  it("returns null when the target is missing or already the root", () => {
    expect(rerootTree(sampleTree(), "nope")).toBeNull();
    expect(rerootTree(sampleTree(), "root")).toBeNull();
  });

  it("makes the target a direct child of the new root, preserving leaves", () => {
    const rerooted = rerootTree(sampleTree(), "c")!;
    expect(rerooted.branchset).toHaveLength(2);
    expect(rerooted.branchset!.some((n) => n.name === "c")).toBe(true);
    expect(countLeaves(rerooted)).toBe(3);
  });

  it("does not mutate the source tree", () => {
    const tree = sampleTree();
    rerootTree(tree, "c");
    expect(tree.name).toBe("root");
    expect(countLeaves(tree)).toBe(3);
  });
});
