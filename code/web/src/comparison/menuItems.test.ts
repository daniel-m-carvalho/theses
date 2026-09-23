/**
 * What the right-click menu offers.
 *
 * Built from the real slice fixture, so "this clade has 8,441 leaves" is a
 * fact about the vibrio tree rather than something invented here.
 */

import { describe, expect, it, vi } from "vitest";
import realSlice from "../tree/__fixtures__/slice.json";
import type { TreeSlice } from "../api/types";
import { gradientFrom } from "../tree/comparisonValues";
import { treeFromSlice } from "../tree/fromSlice";
import { buildMenu, jumpTargetFor, menuTitle, type PendingMenu } from "./menuItems";
import { DEFAULT_BUDGET, EXPAND_ALL_LIMIT, type SideActions, type SideState } from "./useSide";

const slice = realSlice as unknown as TreeSlice;

function sideOf(over: Partial<SideState> = {}): SideState {
  const tree = treeFromSlice(slice);
  return {
    treeId: "vibrio-nj",
    slice,
    tree,
    gradient: gradientFrom(tree, slice.comparison),
    budget: DEFAULT_BUDGET,
    autoBudget: DEFAULT_BUDGET,
    loading: false,
    error: null,
    path: [],
    canGoBack: false,
    ...over,
  };
}

function actions(): SideActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    focus: vi.fn((id: number) => calls.push(`focus:${id}`)),
    back: vi.fn(() => calls.push("back")),
    reset: vi.fn(() => calls.push("reset")),
    setBudget: vi.fn(),
    expandAll: vi.fn(() => calls.push("expandAll")),
    collapseAll: vi.fn(() => calls.push("collapseAll")),
    reload: vi.fn(),
  };
}

/** A wedge from the real slice — a tip standing for a clade nobody expanded. */
function aWedge(state: SideState): number {
  const id = [...state.tree!.truncated][0];
  if (id === undefined) throw new Error("no wedge in the fixture");
  return id;
}

const at = { x: 10, y: 10 };
const by = (items: ReturnType<typeof buildMenu>, label: string) =>
  items.find((item) => item.label === label)!;

describe("right-clicking a node", () => {
  it("offers to expand a wedge, naming how much is behind it", () => {
    const left = sideOf();
    const menu: PendingMenu = { side: 0, at, storedId: aWedge(left) };
    const items = buildMenu(menu, [left, sideOf()], [actions(), actions()]);

    const expand = by(items, "Expand this clade");
    expect(expand.disabledBecause).toBeUndefined();
    // The point of attaching the menu to the node: it can say what it will do.
    expect(expand.detail).toMatch(/leaves — fetches a new slice/);
  });

  it("fetches a slice rooted at the node that was clicked", () => {
    const left = sideOf();
    const act = actions();
    const storedId = aWedge(left);

    const items = buildMenu({ side: 0, at, storedId }, [left, sideOf()], [act, actions()]);
    by(items, "Expand this clade").onSelect!();

    expect(act.calls).toEqual([`focus:${storedId}`]);
  });

  it("will not re-enter the subtree already being shown", () => {
    const left = sideOf();
    const storedId = aWedge(left);
    const already = sideOf({ path: [storedId], canGoBack: true });

    const items = buildMenu({ side: 0, at, storedId }, [already, sideOf()], [actions(), actions()]);
    expect(by(items, "Expand this clade").disabledBecause).toMatch(/already showing/);
    expect(by(items, "Expand this clade").onSelect).toBeUndefined();
  });

  it("locates a LEAF in the other tree, and sends only that panel", () => {
    // Why the two panels exist. A leaf is matched by its label — the same
    // sequence type on both sides — so this is exact.
    const left = sideOf();
    const right = sideOf({ treeId: "vibrio-upgma" });
    const leftAct = actions();
    const rightAct = actions();

    const leaf = [...left.tree!.leaves].find(
      (id) => jumpTargetFor(left, id) !== undefined,
    );
    expect(leaf).toBeDefined();

    const items = buildMenu({ side: 0, at, storedId: leaf }, [left, right], [leftAct, rightAct]);
    const jump = by(items, "Find this leaf in the other tree");
    expect(jump.disabledBecause).toBeUndefined();

    jump.onSelect!();
    expect(rightAct.calls).toHaveLength(1);
    expect(leftAct.calls).toEqual([]);
  });

  it("shows the leaf's whole clade, not the bare leaf", () => {
    // Rooting the other panel at a single leaf leaves one dot on screen and
    // throws away the context you were comparing against.
    const left = sideOf();
    const leaf = [...left.tree!.leaves].find(
      (id) => left.tree!.parentOfStoredId.has(id) &&
        left.gradient.correspondingTo(left.tree!.parentOfStoredId.get(id)!) !== undefined,
    )!;
    const parent = left.tree!.parentOfStoredId.get(leaf)!;

    expect(jumpTargetFor(left, leaf)).toBe(left.gradient.correspondingTo(parent));
    expect(jumpTargetFor(left, leaf)).not.toBe(left.gradient.correspondingTo(leaf));
  });

  it("refuses to locate a clade, because that match is only an approximation", () => {
    // A clade is matched by best leaf overlap, so the "corresponding" clade may
    // share most of its leaves or almost none. Offering the jump would present
    // a guess as a location — and it is worst exactly where the trees disagree,
    // which is the reason to be looking.
    const left = sideOf();
    const items = buildMenu(
      { side: 0, at, storedId: aWedge(left) },
      [left, sideOf()],
      [actions(), actions()],
    );
    const jump = by(items, "Find this leaf in the other tree");
    expect(jump.disabledBecause).toMatch(/only leaves can be located/);
    expect(jump.onSelect).toBeUndefined();
  });

  it("titles the menu with the clade and its size", () => {
    const left = sideOf();
    expect(menuTitle({ side: 0, at, storedId: aWedge(left) }, [left, sideOf()])).toMatch(
      /\d[\d,]* leaves/,
    );
  });
});

describe("right-clicking empty canvas", () => {
  const items = () =>
    buildMenu({ side: 0, at }, [sideOf(), sideOf()], [actions(), actions()]);

  it("offers no node actions, because there is no node", () => {
    const labels = items().map((item) => item.label);
    expect(labels).not.toContain("Expand this clade");
    expect(labels).not.toContain("Find this leaf in the other tree");
    expect(labels).toContain("Expand all");
    expect(labels).toContain("Collapse all");
  });

  it("refuses to expand a tree large enough to hurt the browser", () => {
    // Not a server limit — it answers fine. This is the failure the whole
    // project exists to avoid, so the UI must not offer to reproduce it.
    expect(slice.total_leaves).toBeGreaterThan(EXPAND_ALL_LIMIT);
    const expand = by(items(), "Expand all");
    expect(expand.disabledBecause).toMatch(/overwhelm the browser/);
    expect(expand.onSelect).toBeUndefined();
  });

  it("allows expanding a tree that is small enough", () => {
    const small = sideOf({ slice: { ...slice, total_leaves: 120 } });
    const expand = by(
      buildMenu({ side: 0, at }, [small, sideOf()], [actions(), actions()]),
      "Expand all",
    );
    expect(expand.disabledBecause).toBeUndefined();
    expect(expand.detail).toBe("120 leaves");
  });
});

describe("going back", () => {
  it("is refused at the whole tree, with the reason", () => {
    const items = buildMenu({ side: 0, at }, [sideOf(), sideOf()], [actions(), actions()]);
    expect(by(items, "Go back").disabledBecause).toMatch(/already at the whole tree/);
    expect(by(items, "Reset to the whole tree").disabledBecause).toMatch(/already showing/);
  });

  it("is offered once a subtree has been entered", () => {
    const deep = sideOf({ path: [12, 480], canGoBack: true });
    const act = actions();
    const items = buildMenu({ side: 0, at }, [deep, sideOf()], [act, actions()]);

    const back = by(items, "Go back");
    expect(back.disabledBecause).toBeUndefined();
    expect(back.detail).toBe("one level out of 2");
    back.onSelect!();
    by(items, "Reset to the whole tree").onSelect!();
    expect(act.calls).toEqual(["back", "reset"]);
  });

  it("offers a reset after expanding in place, even without navigating", () => {
    // Budget is the other dimension: "expand all" changes what is shown
    // without moving, so reset has something to undo.
    const expanded = sideOf({ budget: 9_000 });
    const items = buildMenu({ side: 0, at }, [expanded, sideOf()], [actions(), actions()]);
    expect(by(items, "Reset to the whole tree").disabledBecause).toBeUndefined();
  });
});
