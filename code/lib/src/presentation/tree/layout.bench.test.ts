import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseNewick } from "./newick";
import { buildGraph } from "./layout";
import { countLeaves, maxDepth } from "./model";
import type { NewickNode } from "./types";

/**
 * Layout-pipeline measurements on the real dataset.
 *
 * These are *characterisation* tests, not micro-benchmarks: they establish how
 * `buildGraph` scales with the `maxNodes` leaf budget, so performance claims
 * rest on numbers rather than intuition. Assertions are deliberately loose
 * (generous ceilings) so the suite doesn't turn red on a slower CI machine —
 * the value is the printed table, and a guard against order-of-magnitude
 * regressions.
 *
 * Run `npx vitest run layout.bench` and read the table.
 */

const DATASET = path.resolve(__dirname, "../../../../../datasets/gen_trees");

function loadTree(file: string): NewickNode {
  return parseNewick(readFileSync(path.join(DATASET, file), "utf8"));
}

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/** Median of `runs` timings, to damp GC jitter. */
function median(runs: number, fn: () => void): number {
  const samples = Array.from({ length: runs }, () => time(fn)).sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe("layout pipeline characterisation", () => {
  it("parses the vibrio UPGMA tree and reports its shape", () => {
    const t = median(3, () => loadTree("vibrio-upgma-tree.nwk"));
    const tree = loadTree("vibrio-upgma-tree.nwk");

    const leaves = countLeaves(tree);
    const depth = maxDepth(tree);
    console.log(
      `\n  parseNewick: ${t.toFixed(1)}ms — ${leaves} leaves, max depth ${depth}\n`
    );

    expect(leaves).toBeGreaterThan(1000);
    expect(t).toBeLessThan(5000);
  });

  it("scales buildGraph across realistic maxNodes budgets", { timeout: 60_000 }, () => {
    const tree = loadTree("vibrio-upgma-tree.nwk");
    const budgets = [30, 100, 500, 1000, 2000, 5000];
    const rows: string[] = [];

    for (const budget of budgets) {
      let nodes = 0;
      let edges = 0;
      const ms = median(3, () => {
        const { graph } = buildGraph(tree, () => false, budget, "cladogram");
        nodes = graph.order;
        edges = graph.size;
      });
      rows.push(
        `  maxNodes=${String(budget).padStart(5)} → ` +
          `${String(nodes).padStart(6)} graph nodes, ` +
          `${String(edges).padStart(6)} edges, ` +
          `${ms.toFixed(1).padStart(7)}ms`
      );
    }

    console.log("\n" + rows.join("\n") + "\n");

    // Guard: the full-budget build must stay interactive-ish, not minutes.
    const worst = median(1, () => buildGraph(tree, () => false, 5000, "cladogram"));
    expect(worst).toBeLessThan(10_000);
  });

  it("scales roughly linearly, not quadratically", { timeout: 60_000 }, () => {
    // Regression guard for the ordering/pruning complexity. `prepareTree` used
    // to call subtree-walking functions from inside sort comparators, making a
    // build O(n·depth): 5x the budget cost 12x the time (95ms -> 1164ms). With
    // the leaf-derived keys folded bottom-up and memoized it is ~linear. The
    // 8x ceiling on a 5x workload is deliberately loose so a noisy machine
    // doesn't fail the suite, while still catching a return to quadratic.
    const tree = loadTree("vibrio-upgma-tree.nwk");
    const small = median(3, () => buildGraph(tree, () => false, 1000, "cladogram"));
    const large = median(3, () => buildGraph(tree, () => false, 5000, "cladogram"));

    const ratio = large / Math.max(small, 0.01);
    console.log(
      `\n  5x workload cost ${ratio.toFixed(1)}x the time ` +
        `(${small.toFixed(1)}ms -> ${large.toFixed(1)}ms)\n`
    );
    expect(ratio).toBeLessThan(8);
  });

  it("compares cladogram vs phylogram cost at the same budget", () => {
    const tree = loadTree("vibrio-upgma-tree.nwk");
    const clad = median(3, () => buildGraph(tree, () => false, 1000, "cladogram"));
    const phylo = median(3, () => buildGraph(tree, () => false, 1000, "phylogram"));
    console.log(
      `\n  maxNodes=1000 — cladogram ${clad.toFixed(1)}ms, phylogram ${phylo.toFixed(1)}ms\n`
    );
    expect(clad).toBeLessThan(10_000);
    expect(phylo).toBeLessThan(10_000);
  });

  it("reports how many DOM overlay elements each budget implies", () => {
    // Every visible leaf costs a bar div + a label div, repositioned on EVERY
    // Sigma frame; collapsed clades add a wedge. This is the per-frame DOM write
    // count, the overlay technique's ceiling.
    const tree = loadTree("vibrio-upgma-tree.nwk");
    const rows: string[] = [];

    for (const budget of [30, 100, 500, 1000, 2000]) {
      const { nodeMap } = buildGraph(tree, () => false, budget, "cladogram");
      let leaves = 0;
      for (const n of nodeMap.values()) if (n.isLeaf) leaves++;
      rows.push(
        `  maxNodes=${String(budget).padStart(5)} → ${String(leaves).padStart(5)} leaves ` +
          `≈ ${String(leaves * 2).padStart(5)} overlay elements repositioned per frame`
      );
    }

    console.log("\n" + rows.join("\n") + "\n");
    expect(rows).toHaveLength(5);
  });
});
