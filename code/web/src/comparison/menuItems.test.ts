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
    arrivedAt: null,
    jumpError: null,
    canGoBack: false,
    ...over,
  };
}

function actions(): SideActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    focus: vi.fn((id: number) => calls.push(`focus:${id}`)),
    focusWithContext: vi.fn((id: number) => calls.push(`focusWithContext:${id}`)),
    reportJumpFailure: vi.fn((why: string) => calls.push(`jumpFailure:${why}`)),
    dismissJumpFailure: vi.fn(),
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

  it("points at the leaf's exact counterpart, not at a clade guess", () => {
    // Leaves correspond by label, so this is the same sequence type on both
    // sides. Asking from the parent instead would substitute a best-overlap
    // guess for an exact answer, and still land on a tip.
    const left = sideOf();
    const leaf = [...left.tree!.leaves].find(
      (id) => jumpTargetFor(left, id) !== undefined,
    )!;

    expect(jumpTargetFor(left, leaf)).toBe(left.gradient.correspondingTo(leaf));
  });

  it("hands the target over to be widened, never focused bare", () => {
    // A leaf's counterpart is itself a leaf, and a panel rooted at a leaf is
    // one dot. The receiving panel has to widen it — only it knows its own
    // budget, and only the server knows that node's ancestors.
    const left = sideOf();
    const right = sideOf({ treeId: "vibrio-upgma" });
    const rightAct = actions();
    const leaf = [...left.tree!.leaves].find(
      (id) => jumpTargetFor(left, id) !== undefined,
    )!;

    const items = buildMenu(
      { side: 0, at, storedId: leaf },
      [left, right],
      [actions(), rightAct],
    );
    by(items, "Find this leaf in the other tree").onSelect!();

    expect(rightAct.calls).toEqual([`focusWithContext:${jumpTargetFor(left, leaf)}`]);
    expect(rightAct.focus).not.toHaveBeenCalled();
  });

  it("answers when a leaf has no counterpart, rather than greying out", () => {
    // "Not in the other tree" is the result of asking, not a reason the
    // question cannot be put — and a greyed-out item leaves the reader to work
    // out which of the two it is. Across species this is most of a panel.
    const base = sideOf();
    const left: SideState = {
      ...base,
      gradient: { similarityOf: () => undefined, correspondingTo: () => undefined },
    };
    const right = sideOf({ treeId: "vibrio-upgma" });
    const rightAct = actions();
    const leaf = [...base.tree!.leaves][0];

    const items = buildMenu(
      { side: 0, at, storedId: leaf },
      [left, right],
      [actions(), rightAct],
    );
    const jump = by(items, "Find this leaf in the other tree");
    expect(jump.disabledBecause).toBeUndefined();

    jump.onSelect!();
    expect(rightAct.reportJumpFailure).toHaveBeenCalled();
    expect(rightAct.calls[0]).toMatch(/is not in vibrio-upgma/);
    // And nothing moved, because there is nowhere to move to.
    expect(rightAct.focusWithContext).not.toHaveBeenCalled();
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

  it("offers only actions on that clade", () => {
    // "Expand all" under a clade invited reading it as "expand all of this
    // clade" — which is what the first item already does, and does correctly
    // for that clade alone. Navigation went with it: the view menu owns it.
    const left = sideOf();
    const labels = buildMenu(
      { side: 0, at, storedId: aWedge(left) },
      [left, sideOf()],
      [actions(), actions()],
    ).map((item) => item.label);

    // A menu opened on a clade is about that clade and nothing else.
    expect(labels).toEqual(["Expand this clade", "Find this leaf in the other tree"]);
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
