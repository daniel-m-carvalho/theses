// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CladeShapePresenter } from "./clade_shape";
import { ExpandCollapseOperator } from "./expand_collapse";
import { binaryTree, makeHarness, namedTree } from "./harness";

/** Wedges are CSS-border triangles: zero-size divs with a border-*. */
function wedges(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("div")].filter(
    (el) => el.style.borderTop?.includes("solid") && el.style.width === "0px"
  );
}

describe("CladeShapePresenter", () => {
  it("draws no wedge when nothing is collapsed", () => {
    const h = makeHarness(namedTree());
    new CladeShapePresenter().attach(h.viewer);
    h.render();
    expect(wedges(h.container)).toHaveLength(0);
  });

  it("draws a wedge for each collapsed clade", () => {
    const h = makeHarness(namedTree());
    new CladeShapePresenter().attach(h.viewer);
    h.viewer.setCollapseFn((n) => n.name === "b");
    h.render();

    expect(wedges(h.container)).toHaveLength(1);
  });

  it("scales the wedge with the number of leaves hidden", () => {
    const small = makeHarness(binaryTree(2)); // 4 leaves
    const large = makeHarness(binaryTree(6)); // 64 leaves
    for (const h of [small, large]) {
      new CladeShapePresenter().attach(h.viewer);
      h.viewer.setCollapseFn((n) => !!n.branchset?.length && n !== h.viewer.getTree());
      h.render();
    }

    const heightOf = (h: typeof small) =>
      parseFloat(wedges(h.container)[0].style.borderTop);

    expect(heightOf(large)).toBeGreaterThan(heightOf(small));
  });

  it("reports the true hidden leaf count, not the pruned one", () => {
    // The displayed clade is a clone with no children; the count must come from
    // `origin`, i.e. the real subtree behind the tip.
    const h = makeHarness(binaryTree(5)); // 32 leaves
    new CladeShapePresenter().attach(h.viewer);
    h.viewer.setCollapseFn((n) => n === h.viewer.getTree()!.branchset![0]);
    h.render();

    expect(wedges(h.container)[0].title).toBe("16 leaves");
  });

  it("makes the collapsed marker transparent but keeps it clickable", () => {
    // Deliberately transparent rather than size 0: Sigma hit-tests by size, and
    // this overlay is pointer-events:none, so zeroing would destroy the only
    // click target for expanding the clade.
    const h = makeHarness(namedTree());
    new CladeShapePresenter().attach(h.viewer);
    h.viewer.setCollapseFn((n) => n.name === "b");
    h.render();

    const style = h.styleOf("named_b");
    expect(style.color).toBe("rgba(0,0,0,0)");
    expect(style.size).toBeGreaterThan(0); // still hit-testable
  });

  it("leaves the marker visible when hideMarker is false", () => {
    const h = makeHarness(namedTree());
    new CladeShapePresenter({ hideMarker: false }).attach(h.viewer);
    h.viewer.setCollapseFn((n) => n.name === "b");
    h.render();

    expect(h.styleOf("named_b").color).not.toBe("rgba(0,0,0,0)");
  });

  it("points the apex the other way when reflected", () => {
    const normal = makeHarness(namedTree(), { reflect: false });
    const mirrored = makeHarness(namedTree(), { reflect: true });
    for (const h of [normal, mirrored]) {
      new CladeShapePresenter().attach(h.viewer);
      h.viewer.setCollapseFn((n) => n.name === "b");
      h.render();
    }

    const w1 = wedges(normal.container)[0];
    const w2 = wedges(mirrored.container)[0];
    // One uses border-right for the apex, the other border-left.
    expect(!!w1.style.borderRight).not.toBe(!!w2.style.borderRight);
  });

  it("works from collapse state driven by the collapse operator", () => {
    // The two operators share no reference — the presenter reads isCollapsed
    // off the layout nodes (README §9.3).
    const h = makeHarness(binaryTree(4));
    const collapse = new ExpandCollapseOperator();
    collapse.attach(h.viewer);
    new CladeShapePresenter().attach(h.viewer);

    collapse.setDepth(1, false);
    h.render();

    expect(wedges(h.container).length).toBeGreaterThan(0);
  });

  it("removes its overlay on detach", () => {
    const h = makeHarness(namedTree());
    const shapes = new CladeShapePresenter();
    shapes.attach(h.viewer);
    h.viewer.setCollapseFn((n) => n.name === "b");
    h.render();
    expect(wedges(h.container)).toHaveLength(1);

    shapes.detach();
    expect(wedges(h.container)).toHaveLength(0);
  });
});

describe("sizing wedges in a server-summarised view", () => {
  /**
   * The failure this guards: a view holding 50 leaves that stands for 17,645.
   * Calibrating to the 50 makes every wedge hiding more than that saturate,
   * so a clade of twelve and a clade of eight thousand draw identically —
   * which defeats the only thing a wedge has to say.
   */
  it("distinguishes a small hidden clade from a huge one", () => {
    const presenter = new CladeShapePresenter({});
    const at = (leaves: number, standsFor: number): number =>
      // @ts-expect-error probing the private scale deliberately: it is the
      // behaviour under test, and exposing it would widen the public API for
      // a test's convenience.
      presenter.heightFor(leaves, standsFor);

    // Calibrated to what the view stands for, every size is distinguishable.
    expect(at(8_441, 17_645)).toBeGreaterThan(at(400, 17_645));
    expect(at(400, 17_645)).toBeGreaterThan(at(12, 17_645));

    // Calibrated to the 50 leaves locally present, everything at or above 50
    // pins to the top of the scale: a clade of 400 and one of 8,441 draw
    // identically, and the wedge stops carrying information.
    expect(at(400, 50)).toBeCloseTo(at(8_441, 50), 5);
  });
});

describe("colouring wedges by value", () => {
  it("calls a colour function with the real clade, not the pruned clone", () => {
    const h = makeHarness(binaryTree(5)); // 32 leaves
    const seen: number[] = [];
    new CladeShapePresenter({
      color: (node) => {
        seen.push(node.branchset?.length ?? 0);
        return "#ff00ff";
      },
    }).attach(h.viewer);
    h.viewer.setCollapseFn((n) => n === h.viewer.getTree()!.branchset![0]);
    h.render();

    // The clone has no children; only `origin` does. A zero here would mean the
    // function cannot see the subtree it is supposed to describe.
    expect(seen).toEqual([2]);
    expect(wedges(h.container)[0].style.borderRight).toContain("rgb(255, 0, 255)");
  });

  it("falls back to the node's own colour when the function declines", () => {
    const h = makeHarness(namedTree());
    new CladeShapePresenter({ color: () => undefined }).attach(h.viewer);
    h.viewer.setCollapseFn((n) => n.name === "b");
    h.render();

    const side = wedges(h.container)[0].style.borderRight;
    expect(side).toBeTruthy();
    expect(side).not.toContain("undefined");
  });

  it("redraws on setColor, since a presentation switch fires no render", () => {
    const h = makeHarness(namedTree());
    const shape = new CladeShapePresenter({ color: "#000000" });
    shape.attach(h.viewer);
    h.viewer.setCollapseFn((n) => n.name === "b");
    h.render();
    expect(wedges(h.container)[0].style.borderRight).toContain("rgb(0, 0, 0)");

    shape.setColor(() => "#ffd400");
    expect(wedges(h.container)[0].style.borderRight).toContain("rgb(255, 212, 0)");
  });
});
