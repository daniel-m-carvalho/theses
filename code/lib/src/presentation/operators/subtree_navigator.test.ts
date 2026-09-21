// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { SubtreeNavigator } from "./subtree_navigator";
import { binaryTree, makeHarness } from "./harness";
import { prepareTree, orderByName } from "../tree/model";

function navOn(depth = 4, minLeaves = 2) {
  const tree = binaryTree(depth);
  const h = makeHarness(tree);
  const nav = new SubtreeNavigator(h.viewer, minLeaves);
  nav.attach();
  return { tree, h, nav };
}

describe("SubtreeNavigator", () => {
  it("starts at the original tree", () => {
    const { tree, nav } = navOn();
    expect(nav.getDepth()).toBe(0);
    expect(nav.canGoBack()).toBe(false);
    expect(nav.currentRoot()).toBe(tree);
  });

  it("focus makes a clade the view root", () => {
    const { tree, h, nav } = navOn();
    const clade = tree.branchset![0];

    expect(nav.focus(clade)).toBe(true);
    expect(nav.currentRoot()).toBe(clade);
    expect(nav.getDepth()).toBe(1);
    expect(h.setTreeCalls()).toContain(clade); // rendered via setTree
  });

  it("refuses to focus a leaf", () => {
    const { tree, nav } = navOn();
    const leaf = tree.branchset![0].branchset![0].branchset![0].branchset![0];
    expect(nav.focus(leaf)).toBe(false);
    expect(nav.getDepth()).toBe(0);
  });

  it("refuses to focus the current root", () => {
    const { tree, nav } = navOn();
    expect(nav.focus(tree)).toBe(false);
  });

  it("refuses clades under minLeaves", () => {
    const { tree, nav } = navOn(4, 100); // nothing has 100 leaves
    expect(nav.focus(tree.branchset![0])).toBe(false);
  });

  it("resolves a cloned display node to its original before focusing", () => {
    // Double-clicking a rendered node hands us a prepareTree clone.
    const { tree, nav } = navOn();
    const displayed = prepareTree(tree, () => false, 100, orderByName)!;
    const clone = displayed.branchset![0];

    expect(nav.focus(clone)).toBe(true);
    expect(nav.currentRoot()).toBe(clone.origin); // the original, not the clone
  });

  it("back returns one step", () => {
    const { tree, nav } = navOn();
    nav.focus(tree.branchset![0]);
    nav.focus(tree.branchset![0].branchset![0]);
    expect(nav.getDepth()).toBe(2);

    expect(nav.back()).toBe(true);
    expect(nav.currentRoot()).toBe(tree.branchset![0]);
  });

  it("back at the original tree does nothing", () => {
    const { nav } = navOn();
    expect(nav.back()).toBe(false);
  });

  it("reset returns all the way out", () => {
    const { tree, nav } = navOn();
    nav.focus(tree.branchset![0]);
    nav.focus(tree.branchset![0].branchset![0]);

    expect(nav.reset()).toBe(true);
    expect(nav.getDepth()).toBe(0);
    expect(nav.currentRoot()).toBe(tree);
  });

  it("goTo jumps to a trail step (breadcrumb click)", () => {
    const { tree, nav } = navOn();
    nav.focus(tree.branchset![0]);
    nav.focus(tree.branchset![0].branchset![0]);

    expect(nav.goTo(0)).toBe(true);
    expect(nav.currentRoot()).toBe(tree);
  });

  it("goTo rejects out-of-range and the current step", () => {
    const { tree, nav } = navOn();
    nav.focus(tree.branchset![0]);
    expect(nav.goTo(-1)).toBe(false);
    expect(nav.goTo(1)).toBe(false); // already there
    expect(nav.goTo(99)).toBe(false);
  });

  it("exposes a labelled trail for a breadcrumb", () => {
    const { tree, nav } = navOn();
    nav.focus(tree.branchset![0]);

    const path = nav.getPath();
    expect(path).toHaveLength(2);
    expect(path[0].label).toBeTruthy();
    expect(path[1].node).toBe(tree.branchset![0]);
  });

  it("notifies on every trail change", () => {
    const { tree, nav } = navOn();
    const onChange = vi.fn();
    nav.setOnChange(onChange);

    nav.focus(tree.branchset![0]);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.lastCall![0]).toHaveLength(2);
  });

  it("isRoot identifies the current view root, including via a clone", () => {
    const { tree, nav } = navOn();
    const clade = tree.branchset![0];
    nav.focus(clade);

    expect(nav.isRoot(clade)).toBe(true);
    expect(nav.isRoot(tree.branchset![1])).toBe(false);
  });

  it("restarts the trail when the app loads a different tree", () => {
    // A tree the navigator did not set is a new dataset, not a drill-in.
    const { tree, h, nav } = navOn();
    nav.focus(tree.branchset![0]);
    expect(nav.getDepth()).toBe(1);

    h.viewer.setTree(binaryTree(3)); // app-driven load
    expect(nav.getDepth()).toBe(0);
  });

  it("does not restart the trail on its own setTree calls", () => {
    // The re-entrancy guard: focus() renders via setTree, which would otherwise
    // look like an app-driven load and immediately reset the stack.
    const { tree, nav } = navOn();
    nav.focus(tree.branchset![0]);
    nav.focus(tree.branchset![0].branchset![0]);

    expect(nav.getDepth()).toBe(2);
  });
});
