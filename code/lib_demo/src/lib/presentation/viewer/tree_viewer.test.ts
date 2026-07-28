// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// setTree() -> rerender() constructs a Sigma, which needs a WebGL context.
vi.mock("sigma", async () => await import("../../test_support/fake_sigma"));
import type { NewickNode } from "../tree/types";
import { TreeViewer } from "./tree_viewer";

/** A viewer on a detached container — enough for state-level behaviour. */
function viewer() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return new TreeViewer(el);
}

const leaf = (name: string, metadata?: NewickNode["metadata"]): NewickNode => ({
  name,
  metadata,
});

describe("reducer pipelines", () => {
  it("registers node reducers and returns an unregister function", () => {
    const v = viewer();
    const remove = v.addNodeReducer((_n, d) => d);
    expect(typeof remove).toBe("function");
    expect(() => remove()).not.toThrow();
  });

  it("registers edge reducers the same way", () => {
    const v = viewer();
    const remove = v.addEdgeReducer((_e, d) => d);
    expect(typeof remove).toBe("function");
    expect(() => remove()).not.toThrow();
  });

  it("applying reducers without a renderer is a no-op, not a crash", () => {
    // Operators call applyReducers() on state changes, which can happen before
    // the first render (e.g. during attach).
    const v = viewer();
    v.addNodeReducer((_n, d) => d);
    expect(() => v.applyReducers()).not.toThrow();
    expect(() => v.applyEdgeReducers()).not.toThrow();
  });

  it("unregistering twice is safe", () => {
    const v = viewer();
    const remove = v.addNodeReducer((_n, d) => d);
    remove();
    expect(() => remove()).not.toThrow();
  });
});

describe("viewer configuration", () => {
  it("exposes and updates the layout mode", () => {
    const v = viewer();
    expect(v.getLayoutMode()).toBe("cladogram"); // documented default
    v.setLayoutMode("phylogram");
    expect(v.getLayoutMode()).toBe("phylogram");
  });

  it("exposes and updates reflection", () => {
    const v = viewer();
    expect(v.isReflected()).toBe(false);
    v.setReflect(true);
    expect(v.isReflected()).toBe(true);
  });

  it("holds the tree it was given and announces the change", () => {
    const v = viewer();
    const seen: NewickNode[] = [];
    v.events.on("treeChanged", ({ tree }) => seen.push(tree));

    const tree: NewickNode = { name: "root", branchset: [{ name: "a" }] };
    v.setTree(tree);

    expect(v.getTree()).toBe(tree);
    expect(seen).toEqual([tree]);
  });

  it("starts with no tree", () => {
    expect(viewer().getTree()).toBeNull();
  });

  it("makes a statically-positioned container relative, so overlays anchor", () => {
    const el = document.createElement("div");
    el.style.position = "static";
    document.body.appendChild(el);
    new TreeViewer(el);
    expect(el.style.position).toBe("relative");
  });
});

describe("metadata filter", () => {
  it("passes every leaf when no filter is set", () => {
    const v = viewer();
    expect(v.getFilter()).toBeNull();
    expect(v.passesFilter(leaf("a"))).toBe(true);
    expect(v.passesFilter(leaf("b", { country: "PT" }))).toBe(true);
  });

  it("applies the predicate to a leaf's metadata", () => {
    const v = viewer();
    v.setFilter((m) => m.country === "PT");

    expect(v.passesFilter(leaf("a", { country: "PT" }))).toBe(true);
    expect(v.passesFilter(leaf("b", { country: "ES" }))).toBe(false);
  });

  it("hands the predicate an empty object when a leaf has no metadata", () => {
    const v = viewer();
    const seen: unknown[] = [];
    v.setFilter((m) => {
      seen.push(m);
      return true;
    });

    v.passesFilter(leaf("bare"));
    expect(seen[0]).toEqual({}); // never undefined — predicates can index freely
  });

  it("also passes the leaf node, so predicates can use name/category", () => {
    const v = viewer();
    v.setFilter((_m, node) => node.name.startsWith("keep"));

    expect(v.passesFilter(leaf("keep-1"))).toBe(true);
    expect(v.passesFilter(leaf("drop-1"))).toBe(false);
  });

  it("supports multi-category predicates (AND across, OR within)", () => {
    const v = viewer();
    const criteria: Record<string, Set<string>> = {
      country: new Set(["PT", "ES"]),
      sex: new Set(["F"]),
    };
    v.setFilter((m) =>
      Object.entries(criteria).every(
        ([key, allowed]) => allowed.size === 0 || allowed.has(String(m[key]))
      )
    );

    expect(v.passesFilter(leaf("a", { country: "PT", sex: "F" }))).toBe(true);
    expect(v.passesFilter(leaf("b", { country: "ES", sex: "F" }))).toBe(true);
    expect(v.passesFilter(leaf("c", { country: "PT", sex: "M" }))).toBe(false);
    expect(v.passesFilter(leaf("d", { country: "FR", sex: "F" }))).toBe(false);
  });

  it("filters out a leaf missing the filtered key", () => {
    // Documents the default: an absent key is `undefined`, so a strict
    // predicate excludes it. Apps wanting the lenient reading test for null.
    const v = viewer();
    v.setFilter((m) => m.country === "PT");
    expect(v.passesFilter(leaf("nometa"))).toBe(false);
  });

  it("replaces rather than stacks on repeated setFilter calls", () => {
    const v = viewer();
    v.setFilter((m) => m.country === "PT");
    v.setFilter((m) => m.sex === "F"); // last call wins

    expect(v.passesFilter(leaf("a", { country: "ES", sex: "F" }))).toBe(true);
    expect(v.passesFilter(leaf("b", { country: "PT", sex: "M" }))).toBe(false);
  });

  it("restores every leaf on clearFilter", () => {
    const v = viewer();
    v.setFilter(() => false);
    expect(v.passesFilter(leaf("a"))).toBe(false);

    v.clearFilter();
    expect(v.getFilter()).toBeNull();
    expect(v.passesFilter(leaf("a"))).toBe(true);
  });

  it("emits filterChanged on set and on clear", () => {
    const v = viewer();
    const seen: Array<unknown> = [];
    v.events.on("filterChanged", ({ filter }) => seen.push(filter));

    const predicate = () => true;
    v.setFilter(predicate);
    v.clearFilter();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(predicate);
    expect(seen[1]).toBeNull();
  });

  it("does not emit filterChanged when clearing an already-clear filter", () => {
    const v = viewer();
    const onChange = vi.fn();
    v.events.on("filterChanged", onChange);

    v.clearFilter();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not rebuild the graph when the filter changes", () => {
    // The filter is presentation-only: reducer refresh, never a re-layout.
    const v = viewer();
    const rerender = vi.spyOn(v, "rerender");

    v.setFilter(() => true);
    v.clearFilter();

    expect(rerender).not.toHaveBeenCalled();
  });
});

describe("right-click events (context-menu seam)", () => {
  const tree: NewickNode = { name: "root", branchset: [leaf("a"), leaf("b")] };

  /** The fake renderer behind the viewer, with its test-only `emit`. */
  function rendererOf(v: TreeViewer): { emit: (e: string, p: unknown) => void } {
    return v.getRenderer() as unknown as { emit: (e: string, p: unknown) => void };
  }

  /** A Sigma node-event payload: viewport coords + the original DOM event. */
  function payload(node: string | null, original: object) {
    const event = { x: 12, y: 34, original, preventSigmaDefault: () => {} };
    return node === null ? { event, preventSigmaDefault: () => {} } : { node, event, preventSigmaDefault: () => {} };
  }

  it("forwards Sigma's rightClickNode with node, coords and the DOM event", () => {
    const v = viewer();
    v.setTree(tree);
    const seen: unknown[] = [];
    v.events.on("rightClickNode", (e) => seen.push(e));

    const original = { type: "contextmenu" };
    rendererOf(v).emit("rightClickNode", payload("named_a", original));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ node: "named_a", x: 12, y: 34 });
    // The DOM event rides along so the app can suppress the browser menu.
    expect((seen[0] as { original: unknown }).original).toBe(original);
  });

  it("forwards rightClickStage (no node) for dismissing a menu", () => {
    const v = viewer();
    v.setTree(tree);
    const seen: unknown[] = [];
    v.events.on("rightClickStage", (e) => seen.push(e));

    rendererOf(v).emit("rightClickStage", payload(null, { type: "contextmenu" }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ x: 12, y: 34 });
  });

  it("forwards without touching the payload — suppression is container-level", () => {
    // Sigma's rightClick handler never calls preventDefault (unlike doubleClick),
    // and the forwarding does not either: the native menu is swallowed by the
    // container listener below, which also covers overlays Sigma never sees.
    const v = viewer();
    v.setTree(tree);
    const original = { type: "contextmenu", preventDefault: vi.fn() };

    rendererOf(v).emit("rightClickNode", payload("named_a", original));

    expect(original.preventDefault).not.toHaveBeenCalled();
  });

  it("re-binds after a rerender, so the menu keeps working", () => {
    const v = viewer();
    v.setTree(tree);
    const seen: unknown[] = [];
    v.events.on("rightClickNode", (e) => seen.push(e));

    v.rerender(); // new Sigma instance underneath
    rendererOf(v).emit("rightClickNode", payload("named_b", { type: "contextmenu" }));

    expect(seen).toHaveLength(1);
  });
});

describe("container resize", () => {
  // The stub from vitest.setup.ts records instances so a resize can be faked.
  interface Stub {
    observed: Set<Element>;
    trigger: () => void;
  }
  const observers = () =>
    (globalThis.ResizeObserver as unknown as { instances: Stub[] }).instances;

  it("watches its container, since Sigma only binds window resize", () => {
    // A footer appearing or a splitter moving resizes the container without any
    // window resize — Sigma would keep rendering against stale dimensions.
    const before = observers().length;
    const v = viewer();

    expect(observers().length).toBe(before + 1);
    expect(observers()[before].observed.has(v.getContainer())).toBe(true);
  });

  it("re-measures the renderer when the container resizes", () => {
    const v = viewer();
    v.setTree({ name: "root", branchset: [leaf("a"), leaf("b")] });
    const renderer = v.getRenderer() as unknown as { resize: () => void };
    const resize = vi.spyOn(renderer, "resize");

    observers()[observers().length - 1].trigger();

    expect(resize).toHaveBeenCalled();
  });

  it("does not reset the camera, so a resize keeps the user's pan/zoom", () => {
    const v = viewer();
    v.setTree({ name: "root", branchset: [leaf("a"), leaf("b")] });
    const camera = (v.getRenderer() as unknown as { getCamera: () => { setState: unknown } })
      .getCamera();
    const setState = vi.spyOn(camera as { setState: () => void }, "setState");

    observers()[observers().length - 1].trigger();

    expect(setState).not.toHaveBeenCalled();
  });

  it("is safe before a renderer exists", () => {
    viewer(); // no setTree ⇒ no Sigma yet
    expect(() => observers()[observers().length - 1].trigger()).not.toThrow();
  });

  it("stops observing on destroy", () => {
    const v = viewer();
    const stub = observers()[observers().length - 1];
    expect(stub.observed.size).toBe(1);

    v.destroy();

    expect(stub.observed.size).toBe(0);
  });
});

describe("native context-menu suppression", () => {
  /** A real contextmenu event on `el`; returns whether the default was blocked. */
  function rightClick(el: HTMLElement): boolean {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  function containerFor(v: TreeViewer): HTMLElement {
    return v.getContainer();
  }

  it("swallows the native menu inside the container by default", () => {
    const v = viewer();
    expect(rightClick(containerFor(v))).toBe(true);
  });

  it("covers overlay children too, which Sigma's mouse layer cannot", () => {
    // Operator overlays are *siblings* of Sigma's mouse layer, so one that opts
    // into pointer events would swallow the event before Sigma saw it — it still
    // bubbles to the container, which is why the listener lives there.
    const v = viewer();
    const overlayChild = document.createElement("div");
    containerFor(v).appendChild(overlayChild);

    expect(rightClick(overlayChild)).toBe(true);
  });

  it("leaves the native menu alone when opted out", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const v = new TreeViewer(el, { suppressContextMenu: false });

    expect(rightClick(el)).toBe(false);
    expect(v.getContainer()).toBe(el);
  });

  it("does not touch the surrounding page", () => {
    const v = viewer();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    expect(rightClick(containerFor(v))).toBe(true);
    expect(rightClick(outside)).toBe(false); // toolbar / header / footer keep it
  });

  it("stops suppressing after destroy(), since the element outlives the viewer", () => {
    const v = viewer();
    const el = containerFor(v);
    expect(rightClick(el)).toBe(true);

    v.destroy();

    expect(rightClick(el)).toBe(false);
  });
});

describe("selection → structure helpers", () => {
  // root(a, b(c, d)); ids come out as `named_<name>`.
  const tree: NewickNode = {
    name: "root",
    branchset: [
      { name: "a" },
      { name: "b", branchset: [{ name: "c" }, { name: "d" }] },
    ],
  };
  const internalId = (v: TreeViewer, label: string): string =>
    [...v.getNodeMap().values()].find((n) => !n.isLeaf && n.label === label)!.id;

  it("leavesOf resolves selected ids to the leaf names they represent", () => {
    const v = viewer();
    v.setTree(tree);

    expect(v.leavesOf(["named_a"])).toEqual(["a"]);
    expect(v.leavesOf([internalId(v, "b")]).sort()).toEqual(["c", "d"]);
  });

  it("mrcaOf finds the common ancestor of a leaf selection", () => {
    const v = viewer();
    v.setTree(tree);

    expect(v.mrcaOf(["named_c", "named_d"])).toBe(internalId(v, "b"));
    expect(v.mrcaOf(["named_a", "named_c"])).toBe(internalId(v, "root"));
  });

  it("is safe before a tree is set", () => {
    const v = viewer();
    expect(v.leavesOf(["anything"])).toEqual([]);
    expect(v.mrcaOf(["anything"])).toBeNull();
  });
});
