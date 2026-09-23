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
import { buildMenu, menuTitle, type PendingMenu } from "./menuItems";
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
function aWedge(state: SideState): string {
  const id = [...state.tree!.truncated][0];
  for (const [name, storedId] of state.tree!.storedIdOfName) {
    if (storedId === id) return name;
  }
  throw new Error("no wedge in the fixture");
}

const at = { x: 10, y: 10 };
const by = (items: ReturnType<typeof buildMenu>, label: string) =>
  items.find((item) => item.label === label)!;

describe("right-clicking a node", () => {
  it("offers to expand a wedge, naming how much is behind it", () => {
    const left = sideOf();
    const menu: PendingMenu = { side: 0, at, node: aWedge(left) };
    const items = buildMenu(menu, [left, sideOf()], [actions(), actions()]);

    const expand = by(items, "Expand this clade");
    expect(expand.disabledBecause).toBeUndefined();
    // The point of attaching the menu to the node: it can say what it will do.
    expect(expand.detail).toMatch(/leaves — fetches a new slice/);
  });

  it("fetches a slice rooted at the node that was clicked", () => {
    const left = sideOf();
    const act = actions();
    const node = aWedge(left);
    const storedId = left.tree!.storedIdOfName.get(node)!;

    const items = buildMenu({ side: 0, at, node }, [left, sideOf()], [act, actions()]);
    by(items, "Expand this clade").onSelect!();

    expect(act.calls).toEqual([`focus:${storedId}`]);
  });

  it("will not re-enter the subtree already being shown", () => {
    const left = sideOf();
    const node = aWedge(left);
    const storedId = left.tree!.storedIdOfName.get(node)!;
    const already = sideOf({ path: [storedId], canGoBack: true });

    const items = buildMenu({ side: 0, at, node }, [already, sideOf()], [actions(), actions()]);
    expect(by(items, "Expand this clade").disabledBecause).toMatch(/already showing/);
    expect(by(items, "Expand this clade").onSelect).toBeUndefined();
  });

  it("jumps to the matching clade in the OTHER tree, not this one", () => {
    // The whole reason there are two panels. The correspondence was computed
    // once on the server, so this is a lookup.
    const left = sideOf();
    const right = sideOf({ treeId: "vibrio-upgma" });
    const leftAct = actions();
    const rightAct = actions();

    const withPartner = [...left.tree!.storedIdOfName].find(
      ([, id]) => left.gradient.correspondingTo(id) !== undefined,
    );
    expect(withPartner).toBeDefined();
    const [node, storedId] = withPartner!;
    const partner = left.gradient.correspondingTo(storedId)!;

    const items = buildMenu({ side: 0, at, node }, [left, right], [leftAct, rightAct]);
    const jump = by(items, "Show the matching clade on the other side");
    expect(jump.disabledBecause).toBeUndefined();
    expect(jump.detail).toContain("vibrio-upgma");

    jump.onSelect!();
    expect(rightAct.calls).toEqual([`focus:${partner}`]);
    expect(leftAct.calls).toEqual([]);
  });

  it("says so when a clade has no counterpart, rather than hiding the option", () => {
    const left = sideOf({
      gradient: { valueFor: () => undefined, correspondingTo: () => undefined },
    });
    const items = buildMenu(
      { side: 0, at, node: aWedge(left) },
      [left, sideOf()],
      [actions(), actions()],
    );
    const jump = by(items, "Show the matching clade on the other side");
    expect(jump.disabledBecause).toMatch(/no corresponding clade/);
    expect(jump.onSelect).toBeUndefined();
  });

  it("titles the menu with the clade and its size", () => {
    const left = sideOf();
    expect(menuTitle({ side: 0, at, node: aWedge(left) }, [left, sideOf()])).toMatch(
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
    expect(labels).not.toContain("Show the matching clade on the other side");
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
