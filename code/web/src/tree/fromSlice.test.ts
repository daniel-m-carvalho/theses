/**
 * The seam between the API and the viewer.
 *
 * Tested against a slice captured from the running backend rather than one
 * written here, so a change to the wire contract fails this rather than being
 * discovered in the browser.
 */

import { describe, expect, it } from "vitest";
import realSlice from "./__fixtures__/slice.json";
import { treeFromSlice } from "./fromSlice";
import type { TreeSlice } from "../api/types";

const slice = realSlice as unknown as TreeSlice;

function countNodes(node: { branchset?: unknown[] }): number {
  const children = (node.branchset ?? []) as { branchset?: unknown[] }[];
  return 1 + children.reduce((sum, child) => sum + countNodes(child), 0);
}

function collect(node: { branchset?: unknown[] }, into: unknown[] = []): unknown[] {
  into.push(node);
  for (const child of (node.branchset ?? []) as { branchset?: unknown[] }[]) {
    collect(child, into);
  }
  return into;
}

describe("a real slice from the backend", () => {
  it("rebuilds every node, and exactly one tree", () => {
    const built = treeFromSlice(slice);
    expect(countNodes(built.root)).toBe(slice.nodes.id.length);
  });

  it("stands in for the whole tree at a fraction of the size", () => {
    // The claim the backend exists to make: 17,645 leaves reach the browser as
    // ~119 nodes. If this ratio collapses, the slicing is not doing its job.
    expect(slice.total_leaves).toBeGreaterThan(17_000);
    expect(slice.nodes.id.length).toBeLessThan(200);
  });

  it("marks every truncated tip collapsed, so the library draws a wedge", () => {
    const built = treeFromSlice(slice);
    const collapsed = collect(built.root).filter(
      (n) => (n as { collapsed?: boolean }).collapsed,
    );
    const expected = slice.nodes.truncated.filter(Boolean).length;
    expect(collapsed).toHaveLength(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("can name the stored id of any node, which is what a right-click needs", () => {
    const built = treeFromSlice(slice);
    for (const node of collect(built.root)) {
      const id = built.storedIdOf(node as never);
      expect(id).toBeTypeOf("number");
      expect(slice.nodes.id).toContain(id);
    }
  });

  it("follows `origin`, because prepareTree clones before display", () => {
    // The library prunes to a budget and hands operators a clone; without
    // this, a click on a displayed node could not be resolved to a stored id.
    const built = treeFromSlice(slice);
    const original = built.byStoredId.get(slice.root)!;
    const clone = { ...original, origin: original };
    expect(built.storedIdOf(clone)).toBe(slice.root);
  });

  it("keeps true leaf counts, which is what sizes a wedge", () => {
    const built = treeFromSlice(slice);
    const root = built.byStoredId.get(slice.root)!;
    expect(built.trueLeafCountOf(root)).toBe(slice.total_leaves);
  });

  it("indexes stored ids back to slice positions, for comparison values", () => {
    const built = treeFromSlice(slice);
    // Comparison values are positional and aligned to `nodes`, so a node's
    // value is found by its index, never by a join.
    const similarity = slice.comparison!.similarity;
    expect(similarity).toHaveLength(slice.nodes.id.length);
    const at = built.indexOfStoredId.get(slice.root);
    expect(at).toBe(slice.nodes.id.indexOf(slice.root));
  });

  it("labels a large clade with its size, and leaves the small ones bare", () => {
    // A wedge has no identifier of its own, so bare it reads as a leaf whose
    // name went missing. Only the large ones are named: in this slice 31
    // wedges hide 13,349 down to 2, and labelling all of them would be worse
    // than labelling none.
    const built = treeFromSlice(slice);
    const named: { stands: number; name: string }[] = [];
    for (const storedId of built.truncated) {
      const node = built.byStoredId.get(storedId)!;
      named.push({ stands: node.trueLeafCount ?? 0, name: node.name });
    }
    const labelled = named.filter((w) => w.name !== "");
    const bare = named.filter((w) => w.name === "");

    expect(labelled.length).toBeGreaterThan(0);
    expect(bare.length).toBeGreaterThan(labelled.length);
    // Every labelled one is bigger than every bare one.
    expect(Math.min(...labelled.map((w) => w.stands))).toBeGreaterThan(
      Math.max(...bare.map((w) => w.stands)),
    );
    expect(labelled.some((w) => /^[\d,]+ leaves$/.test(w.name))).toBe(true);
  });

  it("blanks the placeholder label the source Newick uses for unnamed nodes", () => {
    // 97 of 119 nodes in this slice are labelled "_". Left alone the layout
    // captions every internal node `_`; an earlier fix captioned them
    // `node-10251`, which is worse — a made-up id shown as if it meant
    // something. Identity lives in metadata, not in the name.
    const built = treeFromSlice(slice);
    const nodes = collect(built.root) as { name: string; metadata?: Record<string, unknown> }[];
    expect(nodes.some((n) => n.name === "")).toBe(true);
    expect(nodes.every((n) => n.name !== "_")).toBe(true);
    // Real leaf labels survive untouched.
    expect(nodes.some((n) => /^\d+$/.test(n.name))).toBe(true);
    // And some tips are still bare: the small clades.
    expect(nodes.some((n) => n.name === "")).toBe(true);
    // And every node still knows its backend id.
    expect(nodes.every((n) => typeof n.metadata?.storedId === "number")).toBe(true);
  });
});

describe("a malformed slice", () => {
  const minimal = (over: Partial<TreeSlice["nodes"]>): TreeSlice =>
    ({
      tree: "t",
      root: 0,
      budget: 10,
      displayed_leaves: 2,
      hidden_leaves: 0,
      total_leaves: 2,
      nodes: {
        id: [0, 1, 2],
        parent: [-1, 0, 0],
        label: ["", "A", "B"],
        branch_len: [null, 1, 2],
        true_leaf_count: [2, 1, 1],
        truncated: [false, false, false],
        ...over,
      },
    }) as TreeSlice;

  it("is refused rather than drawn half-built", () => {
    // A parent index outside the arrays means the response and this code
    // disagree about the contract. Rendering part of it would hide that.
    expect(() => treeFromSlice(minimal({ parent: [-1, 0, 99] }))).toThrow(/outside/);
    expect(() => treeFromSlice(minimal({ parent: [-1, -1, 0] }))).toThrow(/more than one root/);
    expect(() => treeFromSlice(minimal({ parent: [1, 0, 0] }))).toThrow(/no root/);
  });

  it("refuses an empty slice", () => {
    expect(() =>
      treeFromSlice(minimal({ id: [], parent: [], label: [], branch_len: [], true_leaf_count: [], truncated: [] })),
    ).toThrow(/no nodes/);
  });

  it("keeps a null branch length absent rather than zero", () => {
    // null means "the source Newick gave no length"; zero would be a claim.
    const built = treeFromSlice(minimal({}));
    expect(built.root.length).toBeUndefined();
    expect(built.root.branchset?.[0].length).toBe(1);
  });
});
