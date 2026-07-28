// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { NewickNode } from "../tree/types";
import type { TreeViewer } from "../viewer/tree_viewer";
import { Emitter } from "../viewer/emitter";
import { orderByName, prepareTree } from "../tree/model";
import { buildGraph, type LayoutNode } from "../tree/layout";
import { ExpandCollapseOperator } from "./expand_collapse";

/**
 * A balanced binary tree of `depth` levels. Internal nodes are unnamed — the
 * case that matters, since UPGMA/NJ exports leave internals unnamed and the
 * operator must key them structurally rather than by name.
 */
function binaryTree(depth: number, path = ""): NewickNode {
  if (depth === 0) return { name: `L${path}`, length: 1 };
  return {
    name: "",
    length: 1,
    branchset: [binaryTree(depth - 1, `${path}0`), binaryTree(depth - 1, `${path}1`)],
  };
}

/** Minimal viewer stub: only what the operator actually touches. */
function fakeViewer(tree: NewickNode) {
  const container = document.createElement("div");
  const rerender = vi.fn();
  const setTree = vi.fn();
  const viewer = {
    events: new Emitter(),
    getContainer: () => container,
    getTree: () => tree,
    setTree,
    rerender,
    setCollapseFn: vi.fn(),
    addNodeReducer: vi.fn(() => vi.fn()),
    getNodeMap: () => new Map(),
  };
  return { viewer: viewer as unknown as TreeViewer, rerender, setTree };
}

/** Collect every node of a tree, depth-first. */
function allNodes(tree: NewickNode): NewickNode[] {
  const out: NewickNode[] = [];
  (function walk(n: NewickNode) {
    out.push(n);
    (n.branchset ?? []).forEach(walk);
  })(tree);
  return out;
}

describe("stable structural IDs", () => {
  it("keys the root 'r' and children by path", () => {
    const tree = binaryTree(2);
    const op = new ExpandCollapseOperator();
    op.bind(tree);

    expect(op.idOf(tree)).toBe("r");
    expect(op.idOf(tree.branchset![0])).toBe("r.0");
    expect(op.idOf(tree.branchset![1])).toBe("r.1");
    expect(op.idOf(tree.branchset![1].branchset![0])).toBe("r.1.0");
  });

  it("gives unnamed internal nodes distinct IDs", () => {
    const tree = binaryTree(3);
    const op = new ExpandCollapseOperator();
    op.bind(tree);

    const ids = allNodes(tree).map((n) => op.idOf(n));
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every((id) => id !== "")).toBe(true); // all bound
  });

  it("returns an empty ID for a node from an unbound tree", () => {
    const op = new ExpandCollapseOperator();
    expect(op.idOf({ name: "stranger" })).toBe("");
  });
});

describe("origin resolution (regression: collapse silently did nothing)", () => {
  // prepareTree CLONES the tree for display, so a rendered node is never
  // identity-equal to its source. Before `origin` existed, the toggle looked up
  // the clone in a WeakMap keyed on originals, missed every time, and collapse
  // appeared to do nothing at all. These lock that fix in.
  it("resolves a cloned display node to its original's ID", () => {
    const tree = binaryTree(3);
    const op = new ExpandCollapseOperator();
    op.bind(tree);

    const displayed = prepareTree(tree, () => false, 100, orderByName)!;
    const displayedChild = displayed.branchset![0];
    const originalChild = displayedChild.origin!;

    expect(displayedChild).not.toBe(originalChild); // really is a clone
    expect(op.idOf(displayedChild)).toBe(op.idOf(originalChild)); // same ID anyway
    expect(op.idOf(displayedChild)).not.toBe("");
  });

  it("collapses via a cloned node and the predicate sees it on the original", () => {
    const tree = binaryTree(3);
    const op = new ExpandCollapseOperator();
    op.bind(tree);

    const displayed = prepareTree(tree, () => false, 100, orderByName)!;
    const clone = displayed.branchset![0];

    op.toggleFromSource({ source: clone, isLeaf: false });

    // The predicate runs against ORIGINAL nodes during the next prepareTree.
    expect(op.isCollapsed(clone.origin!)).toBe(true);
  });

  it("keeps a collapsed clade togglable after it renders as a terminal", () => {
    const tree = binaryTree(3);
    const op = new ExpandCollapseOperator();
    op.bind(tree);
    const target = tree.branchset![0];

    op.collapse(target);
    const displayed = prepareTree(tree, (n) => op.isCollapsed(n), 100, orderByName)!;
    const collapsedTip = displayed.branchset!.find((n) => n.collapsed)!;

    expect(collapsedTip.branchset).toBeUndefined(); // drawn as a tip
    expect(collapsedTip.origin).toBe(target); // still resolves
    expect(op.toggleFromSource({ source: collapsedTip, isLeaf: false })).toBe(true);
    expect(op.isCollapsed(target)).toBe(false); // expanded again
  });
});

describe("collapse / expand basics", () => {
  it("never treats a leaf as collapsed", () => {
    const tree = binaryTree(2);
    const op = new ExpandCollapseOperator();
    op.bind(tree);
    const leaf = tree.branchset![0].branchset![0];

    op.collapse(leaf); // no-op
    expect(op.isCollapsed(leaf)).toBe(false);
    expect(op.toggleFromSource({ source: leaf, isLeaf: true })).toBe(false);
  });

  it("collapsing folds the entire subtree in one step", () => {
    const tree = binaryTree(4);
    const op = new ExpandCollapseOperator();
    op.bind(tree);
    const clade = tree.branchset![0];

    op.toggleFromSource({ source: clade, isLeaf: false });
    expect(op.isCollapsed(clade)).toBe(true);
  });

  it("drops collapse state whose IDs no longer exist when rebinding", () => {
    const tree = binaryTree(3);
    const op = new ExpandCollapseOperator();
    op.bind(tree);
    op.collapse(tree.branchset![0]);
    expect(op.getCollapsed().has("r.0")).toBe(true);

    op.bind(binaryTree(1)); // shallower tree: "r.0" is now a leaf-only path
    expect(op.getCollapsed().has("r.0.0")).toBe(false);
  });
});

describe("expandDepth — how much one expand reveals", () => {
  it("opens exactly `expandDepth` levels and re-folds below", () => {
    const tree = binaryTree(5);
    const op = new ExpandCollapseOperator({ expandDepth: 2 });
    op.bind(tree);

    op.openSubtree(tree, 2);

    // Root and its immediate children are open...
    expect(op.isCollapsed(tree)).toBe(false);
    expect(op.isCollapsed(tree.branchset![0])).toBe(false);
    // ...and the level below that is folded, so it stops there.
    expect(op.isCollapsed(tree.branchset![0].branchset![0])).toBe(true);
  });

  it("defaults to one level, which on a binary tree is a single bifurcation", () => {
    const tree = binaryTree(4);
    const op = new ExpandCollapseOperator(); // expandDepth defaults to 1
    op.bind(tree);
    expect(op.getExpandDepth()).toBe(1);

    op.openSubtree(tree);
    expect(op.isCollapsed(tree)).toBe(false);
    expect(op.isCollapsed(tree.branchset![0])).toBe(true); // children already folded
  });

  it("clamps expandDepth to at least 1", () => {
    const op = new ExpandCollapseOperator({ expandDepth: 0 });
    expect(op.getExpandDepth()).toBe(1);
    op.setExpandDepth(-5);
    expect(op.getExpandDepth()).toBe(1);
  });

  it("re-expanding a collapsed clade opens expandDepth levels, not everything", () => {
    const tree = binaryTree(5);
    const op = new ExpandCollapseOperator({ expandDepth: 1 });
    op.bind(tree);
    const clade = tree.branchset![0];

    op.collapse(clade);
    op.toggleFromSource({ source: clade, isLeaf: false }); // expand

    expect(op.isCollapsed(clade)).toBe(false);
    expect(op.isCollapsed(clade.branchset![0])).toBe(true); // grandchildren re-folded
  });
});

describe("setDepth — one primitive, both directions", () => {
  it("cuts the tree uniformly at the given depth", () => {
    const tree = binaryTree(4);
    const { viewer } = fakeViewer(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);

    op.setDepth(2, false);

    expect(op.isCollapsed(tree)).toBe(false); // depth 0, open
    expect(op.isCollapsed(tree.branchset![0])).toBe(false); // depth 1, open
    expect(op.isCollapsed(tree.branchset![0].branchset![0])).toBe(true); // depth 2, cut
    expect(op.getDepth()).toBe(2);
  });

  it("expands when given a larger depth than the current cut", () => {
    const tree = binaryTree(4);
    const { viewer } = fakeViewer(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);

    op.setDepth(1, false);
    expect(op.isCollapsed(tree.branchset![0])).toBe(true);

    op.setDepth(3, false); // same call, opposite effect
    expect(op.isCollapsed(tree.branchset![0])).toBe(false);
    expect(op.getDepth()).toBe(3);
  });

  it("reports a null depth once a clade is toggled by hand", () => {
    const tree = binaryTree(4);
    const { viewer } = fakeViewer(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);

    op.setDepth(2, false);
    expect(op.getDepth()).toBe(2);

    op.toggleFromSource({ source: tree.branchset![0], isLeaf: false });
    expect(op.getDepth()).toBeNull(); // no longer a uniform cut
  });

  it("clamps a negative depth to 0", () => {
    const tree = binaryTree(3);
    const { viewer } = fakeViewer(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);

    op.setDepth(-3, false);
    expect(op.getDepth()).toBe(0);
    expect(op.isCollapsed(tree)).toBe(true); // whole tree folds to the root tip
  });

  it("expandAll clears every collapsed clade", () => {
    const tree = binaryTree(4);
    const { viewer } = fakeViewer(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);

    op.setDepth(1, false);
    expect(op.getCollapsed().size).toBeGreaterThan(0);

    op.expandAll();
    expect(op.getCollapsed().size).toBe(0);
    expect(op.getDepth()).toBeNull();
  });

  it("applies initialDepth when a tree arrives", () => {
    const tree = binaryTree(4);
    const { viewer } = fakeViewer(tree);
    const op = new ExpandCollapseOperator({ initialDepth: 2 });
    op.attach(viewer);

    viewer.events.emit("treeChanged", { tree });

    expect(op.getDepth()).toBe(2);
    expect(op.isCollapsed(tree.branchset![0].branchset![0])).toBe(true);
  });
});

describe("collapseNodes / expandNodes — batch by graph id (for selections)", () => {
  /** A viewer whose node map is a real built layout, so ids resolve to sources. */
  function viewerWithMap(tree: NewickNode) {
    const built = buildGraph(tree, () => false, 100, "cladogram");
    const container = document.createElement("div");
    const rerender = vi.fn();
    const viewer = {
      events: new Emitter(),
      getContainer: () => container,
      getTree: () => tree,
      setTree: vi.fn(),
      rerender,
      setCollapseFn: vi.fn(),
      addNodeReducer: vi.fn(() => vi.fn()),
      getNodeMap: () => built.nodeMap,
    };
    return { viewer: viewer as unknown as TreeViewer, rerender, built };
  }

  /** An internal (collapsible) node that isn't the root — the "select a clade" case. */
  function nonRootClade(nodeMap: Map<string, LayoutNode>): LayoutNode {
    const childIds = new Set<string>();
    for (const n of nodeMap.values()) for (const c of n.children) childIds.add(c.id);
    return [...nodeMap.values()].find((n) => !n.isLeaf && childIds.has(n.id))!;
  }

  it("collapses the selected clade and rerenders exactly once", () => {
    const tree = binaryTree(4);
    const { viewer, rerender, built } = viewerWithMap(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);
    rerender.mockClear();

    const clade = nonRootClade(built.nodeMap);
    op.collapseNodes([clade.id]);

    expect(op.isCollapsed(clade.source.origin!)).toBe(true);
    expect(rerender).toHaveBeenCalledTimes(1); // one rebuild for the whole batch
  });

  it("collapses many selected clades in a single rerender", () => {
    const tree = binaryTree(4);
    const { viewer, rerender, built } = viewerWithMap(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);
    rerender.mockClear();

    const clades = [...built.nodeMap.values()].filter((n) => !n.isLeaf).slice(0, 3);
    op.collapseNodes(clades.map((c) => c.id));

    expect(op.getCollapsed().size).toBeGreaterThan(0);
    expect(rerender).toHaveBeenCalledTimes(1); // NOT once per node
  });

  it("ignores selected leaves — they are not clades", () => {
    const tree = binaryTree(4);
    const { viewer, rerender, built } = viewerWithMap(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);
    rerender.mockClear();

    const leaf = [...built.nodeMap.values()].find((n) => n.isLeaf)!;
    op.collapseNodes([leaf.id]);

    expect(op.getCollapsed().size).toBe(0);
    expect(rerender).not.toHaveBeenCalled(); // nothing changed, no rebuild
  });

  it("does nothing (and doesn't rerender) for unknown ids", () => {
    const tree = binaryTree(3);
    const { viewer, rerender } = viewerWithMap(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);
    rerender.mockClear();

    op.collapseNodes(["not-a-real-id"]);
    expect(rerender).not.toHaveBeenCalled();
  });

  it("expandNodes reverses a collapse, also in one rerender", () => {
    const tree = binaryTree(4);
    const { viewer, rerender, built } = viewerWithMap(tree);
    const op = new ExpandCollapseOperator();
    op.attach(viewer);

    const clade = nonRootClade(built.nodeMap);
    op.collapseNodes([clade.id]);
    expect(op.isCollapsed(clade.source.origin!)).toBe(true);
    rerender.mockClear();

    op.expandNodes([clade.id]);
    expect(op.isCollapsed(clade.source.origin!)).toBe(false);
    expect(rerender).toHaveBeenCalledTimes(1);
  });
});
