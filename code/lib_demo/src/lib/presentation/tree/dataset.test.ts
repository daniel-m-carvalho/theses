import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseNewick } from "./newick";
import { buildGraph } from "./layout";
import { countLeaves, getSubtreeLeaves, maxDepth } from "./model";
import { keyByClade } from "../data/comparison";
import type { NewickNode } from "./types";

/**
 * Integration tests over the **real** dataset files.
 *
 * Every other suite uses small synthetic trees: fast, deterministic, and precise
 * about expected values. But real phylogenetic output has properties a
 * hand-built tree does not — ladder-shaped clades hundreds of levels deep,
 * unnamed internal nodes, repeated leaf labels, and the ';'-separated forest
 * that goeBURST emits. Those shapes are where the pipeline actually breaks
 * (deep recursion overflowing the stack, id collisions, quadratic ordering), so
 * these run each shipped file end-to-end and assert invariants rather than
 * hardcoded numbers.
 */

const DATASET = path.resolve(__dirname, "../../../../../../datasets/gen_trees");

/**
 * Hierarchical trees — the representations the library actually supports.
 * UPGMA/NJ produce rooted dendrograms, which is what cladogram/phylogram assert.
 */
const DENDROGRAM_FILES = [
  "vibrio-upgma-tree.nwk",
  "vibrio-nj-tree.nwk",
  "clostridium-upgma-tree.nwk",
] as const;

/**
 * goeBURST output — **not** a supported representation (README §16).
 *
 * These are minimum spanning trees over allelic profiles: nodes are STs, edges
 * are locus differences, and there is no root and no nested clade hierarchy.
 * Rendering them as a dendrogram imposes ancestry the data does not assert, so
 * the tests below check only that out-of-scope input degrades safely rather than
 * crashing — they are robustness checks, NOT evidence of support. Supporting
 * goeBURST properly means a new LayoutEngine (network/MST), not a fix here.
 */
const NETWORK_FILES = [
  "vibrio-goeburst-tree.nwk",
  "clostridium-goeburst-tree.nwk",
  "salmonella-100k-goeburst-tree.nwk",
] as const;

const FILES = [...DENDROGRAM_FILES, ...NETWORK_FILES] as const;

const load = (file: string): NewickNode =>
  parseNewick(readFileSync(path.join(DATASET, file), "utf8"));

describe.each(FILES)("dataset: %s", (file) => {
  it("parses into a non-trivial tree", { timeout: 30_000 }, () => {
    const tree = load(file);
    expect(countLeaves(tree)).toBeGreaterThan(1);
    expect(tree.branchset?.length).toBeGreaterThan(0);
  });

  it("survives the layout pipeline at several budgets", { timeout: 30_000 }, () => {
    const tree = load(file);
    for (const budget of [30, 200, 1000]) {
      const { graph, nodeMap } = buildGraph(tree, () => false, budget, "cladogram");
      expect(graph.order).toBeGreaterThan(0);

      const leaves = [...nodeMap.values()].filter((n) => n.isLeaf);
      expect(leaves.length).toBeLessThanOrEqual(budget);
      expect(leaves.length).toBeGreaterThan(0);
    }
  });

  it("produces finite coordinates everywhere", { timeout: 30_000 }, () => {
    // A zero-length branch or a degenerate distance scale can yield NaN, which
    // renders as an invisible node rather than an error.
    const { graph } = buildGraph(load(file), () => false, 500, "phylogram");
    graph.forEachNode((_id, attrs) => {
      expect(Number.isFinite(attrs.x as number)).toBe(true);
      expect(Number.isFinite(attrs.y as number)).toBe(true);
    });
  });

  it("aligns every tip to one column", { timeout: 30_000 }, () => {
    const { nodeMap } = buildGraph(load(file), () => false, 300, "phylogram");
    const xs = new Set(
      [...nodeMap.values()].filter((n) => n.isLeaf).map((n) => n.x)
    );
    expect(xs.size).toBe(1);
  });

  it("handles both layout modes", { timeout: 30_000 }, () => {
    const tree = load(file);
    for (const mode of ["cladogram", "phylogram"] as const) {
      expect(() => buildGraph(tree, () => false, 300, mode)).not.toThrow();
    }
  });

  it("collapses real clades without losing the tree", { timeout: 30_000 }, () => {
    const tree = load(file);
    const open = buildGraph(tree, () => false, 500, "cladogram").nodeMap;
    // Collapse everything below the root's immediate children.
    const topLevel = new Set(tree.branchset ?? []);
    const folded = buildGraph(
      tree,
      (n) => topLevel.has(n) && !!n.branchset?.length,
      500,
      "cladogram"
    ).nodeMap;

    const openLeaves = [...open.values()].filter((n) => n.isLeaf).length;
    const foldedLeaves = [...folded.values()].filter((n) => n.isLeaf).length;
    expect(foldedLeaves).toBeLessThanOrEqual(openLeaves);
    expect(folded.size).toBeGreaterThan(0);
  });
});

describe("real-data shapes the synthetic trees don't have", () => {
  it("handles trees hundreds of levels deep without overflowing the stack", () => {
    // The vibrio UPGMA tree is a ~443-deep ladder. Anything walking it
    // recursively per node is a stack-overflow risk on deeper datasets.
    const tree = load("vibrio-upgma-tree.nwk");
    expect(maxDepth(tree)).toBeGreaterThan(100);

    expect(() => countLeaves(tree)).not.toThrow();
    expect(() => getSubtreeLeaves(tree)).not.toThrow();
    expect(() => buildGraph(tree, () => false, 1000, "cladogram")).not.toThrow();
  });

  it("gives every graph node a unique id despite repeated labels", () => {
    // Layout ids are `named_<name>` for the first occurrence and `n<seq>`
    // after, so duplicate labels in real data must not collide.
    const { graph } = buildGraph(
      load("vibrio-upgma-tree.nwk"),
      () => false,
      1000,
      "cladogram"
    );
    const ids = graph.nodes();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reduces a goeBURST forest to its largest component, dropping the rest", () => {
    // These files are one line of many ';'-separated components: a dominant
    // cluster plus thousands of singleton STs. parseNewick keeps only the
    // largest, so most of the forest is silently discarded — one reason
    // goeBURST needs its own representation rather than this pipeline (§16).
    const text = readFileSync(path.join(DATASET, "vibrio-goeburst-tree.nwk"), "utf8");
    const components = text.split(";").filter((c) => c.trim().length > 0);
    const kept = load("vibrio-goeburst-tree.nwk");

    expect(components.length).toBeGreaterThan(1); // it really is a forest
    expect(countLeaves(kept)).toBeGreaterThan(1); // and we keep one component
    expect(countLeaves(kept)).toBeLessThan(components.length); // ...not all of it
  });

  it("keys real clades canonically and distinctly", () => {
    const tree = load("vibrio-upgma-tree.nwk");
    const clades = (tree.branchset ?? []).filter((n) => n.branchset?.length);
    const keys = clades.map(keyByClade);

    expect(keys.every((k) => k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length); // sibling clades differ
  });
});

describe("cross-tree correspondence (UPGMA vs NJ)", () => {
  /** Every internal clade of `tree` with at most `maxSize` leaves, keyed canonically. */
  function smallCladeKeys(tree: NewickNode, maxSize: number): Map<string, number> {
    // Keying every clade would be O(n²) on 17.6k leaves — a clade's key is its
    // whole leaf-set. Large clades are also exactly the ones that cannot match
    // across methods, so filter by the (memoized) leaf count first.
    const out = new Map<string, number>();
    const stack = [tree];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (!n.branchset?.length) continue;
      const size = countLeaves(n);
      if (size <= maxSize) out.set(keyByClade(n), size);
      for (const c of n.branchset) stack.push(c);
    }
    return out;
  }

  it("measures which clade sizes actually correspond", { timeout: 60_000 }, () => {
    // The comparison operator matches nodes by canonical leaf-set (keyByClade),
    // i.e. exact bipartition equality. This measures how much a comparison can
    // highlight on real data — a design input, not a pass/fail threshold.
    const upgma = load("vibrio-upgma-tree.nwk");
    const nj = load("vibrio-nj-tree.nwk");

    // Leaves first: both trees describe the same isolates, so tips should agree
    // almost entirely — that is what makes keyByName viable where keyByClade isn't.
    const leafNames = (t: NewickNode) => new Set(getSubtreeLeaves(t).map((l) => l.name));
    const la = leafNames(upgma);
    const lb = leafNames(nj);
    const sharedLeaves = [...la].filter((n) => lb.has(n)).length;

    const MAX = 64;
    const a = smallCladeKeys(upgma, MAX);
    const b = smallCladeKeys(nj, MAX);

    const buckets: Array<[string, (n: number) => boolean]> = [
      ["2 (cherries)", (n) => n === 2],
      ["3–5", (n) => n >= 3 && n <= 5],
      ["6–10", (n) => n >= 6 && n <= 10],
      ["11–64", (n) => n >= 11 && n <= 64],
    ];

    const lines = [
      `  leaves:        ${sharedLeaves}/${la.size} shared ` +
        `(${((sharedLeaves / la.size) * 100).toFixed(1)}%)`,
    ];
    for (const [label, inBucket] of buckets) {
      const keys = [...a].filter(([, size]) => inBucket(size)).map(([k]) => k);
      const shared = keys.filter((k) => b.has(k)).length;
      const pct = keys.length ? ((shared / keys.length) * 100).toFixed(1) : "—";
      lines.push(
        `  clades ${label.padEnd(13)} ${String(shared).padStart(5)}/${String(keys.length).padEnd(5)} shared (${pct}%)`
      );
    }
    console.log("\n" + lines.join("\n") + "\n");

    // Leaves must correspond — the trees describe the same isolates. If this
    // ever fails, the two files are not comparable at all.
    expect(sharedLeaves).toBeGreaterThan(la.size * 0.9);
  });
});
