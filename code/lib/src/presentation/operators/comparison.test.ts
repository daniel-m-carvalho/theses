// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ComparisonOperator } from "./comparison";
import { SequentialColorScale } from "../color/color_scale";
import { keyByName } from "../data/comparison";
import { makeHarness, namedTree } from "./harness";

describe("ComparisonOperator — lifecycle & state", () => {
  it("defaults to gradient mode and enabled", () => {
    // Note the operator defaults to enabled; the *config* layer decides whether
    // a panel starts showing differences (ComparisonConfig.enabled, default off).
    const cmp = new ComparisonOperator();
    expect(cmp.getMode()).toBe("gradient");
    expect(cmp.isEnabled()).toBe(true);
  });

  it("honours the enabled and mode options", () => {
    const cmp = new ComparisonOperator({ enabled: true, mode: "membership" });
    expect(cmp.isEnabled()).toBe(true);
    expect(cmp.getMode()).toBe("membership");
  });

  it("switches mode at runtime", () => {
    const cmp = new ComparisonOperator();
    cmp.setMode("membership");
    expect(cmp.getMode()).toBe("membership");
  });

  it("attaches and detaches without throwing", () => {
    const h = makeHarness(namedTree());
    const cmp = new ComparisonOperator({ enabled: true });
    cmp.attach(h.viewer);
    h.render();
    expect(() => cmp.detach()).not.toThrow();
  });
});

describe("ComparisonOperator — gradient mode", () => {
  const values = () => new Map([["a", 0], ["c", 1]]);

  it("colors a branch by its child node's value", () => {
    const h = makeHarness(namedTree());
    new ComparisonOperator({
      enabled: true,
      values: values(),
      keyOf: keyByName,
      scale: new SequentialColorScale({ stops: ["#000000", "#ffffff"] }),
    }).attach(h.viewer);
    h.render();

    // Values 0 and 1 sit at opposite ends of the ramp, so the branches differ.
    const low = h.edgeStyleOf("named_a");
    const high = h.edgeStyleOf("named_c");
    expect(low).toBeTruthy();
    expect(high).toBeTruthy();
    expect(low!.color).not.toBe(high!.color);
  });

  it("leaves a branch untouched when the backend has no value for it", () => {
    // Absent data must look absent, never a fabricated mid-scale color.
    const h = makeHarness(namedTree());
    const before = h.edgeStyleOf("named_d")!.color;

    new ComparisonOperator({
      enabled: true,
      values: values(), // no entry for 'd'
      keyOf: keyByName,
    }).attach(h.viewer);
    h.render();

    expect(h.edgeStyleOf("named_d")!.color).toBe(before);
  });

  it("does not color branches while disabled", () => {
    const h = makeHarness(namedTree());
    // Use 'c' (value 1 -> white); 'a' is value 0, which maps to #000000 and is
    // indistinguishable from the default branch color.
    const before = h.edgeStyleOf("named_c")!.color;

    const cmp = new ComparisonOperator({
      enabled: false,
      values: values(),
      keyOf: keyByName,
      scale: new SequentialColorScale({ stops: ["#000000", "#ffffff"] }),
    });
    cmp.attach(h.viewer);
    h.render();
    expect(h.edgeStyleOf("named_c")!.color).toBe(before);

    cmp.setEnabled(true);
    expect(h.edgeStyleOf("named_c")!.color).not.toBe(before);
  });

  it("leaves node markers alone by default (colorNodes off)", () => {
    // A gradient value describes a branch; coloring the node too double-encodes
    // it and would fight CladeShapePresenter's transparent marker.
    const h = makeHarness(namedTree());
    const before = h.styleOf("named_a").color;

    new ComparisonOperator({
      enabled: true,
      values: values(),
      keyOf: keyByName,
    }).attach(h.viewer);
    h.render();

    expect(h.styleOf("named_a").color).toBe(before);
  });

  it("colors internal markers but keeps leaves neutral when colorNodes is on", () => {
    const h = makeHarness(namedTree());
    new ComparisonOperator({
      enabled: true,
      colorNodes: true,
      leafColor: "#123456",
      values: new Map([["b", 1]]),
      keyOf: keyByName,
      scale: new SequentialColorScale({ stops: ["#000000", "#ffffff"] }),
    }).attach(h.viewer);
    h.render();

    expect(h.styleOf("named_a").color).toBe("#123456"); // leaf: neutral
    expect(h.styleOf("named_b").color).toBe("#ffffff"); // internal: valued
  });

  it("accepts values supplied after construction", () => {
    const h = makeHarness(namedTree());
    const cmp = new ComparisonOperator({
      enabled: true,
      keyOf: keyByName,
      scale: new SequentialColorScale({ stops: ["#000000", "#ffffff"] }),
    });
    cmp.attach(h.viewer);
    h.render();
    const before = h.edgeStyleOf("named_a")!.color;

    cmp.setValues(new Map([["a", 1]]));
    expect(h.edgeStyleOf("named_a")!.color).not.toBe(before);
  });
});

describe("ComparisonOperator — membership mode", () => {
  it("marks leaves the backend does NOT list as differing", () => {
    // The mode encodes agreement: shared leaves get equalColor + a marker.
    const h = makeHarness(namedTree());
    new ComparisonOperator({
      enabled: true,
      mode: "membership",
      keyOf: keyByName,
      differing: ["a"], // 'a' differs; 'c' and 'd' are shared
      equalColor: "#00ff00",
    }).attach(h.viewer);
    h.render();

    expect(h.styleOf("named_c").color).toBe("#00ff00");
    expect(h.styleOf("named_a").color).not.toBe("#00ff00");
  });

  it("leaves internal nodes untouched (the mode describes tips)", () => {
    const h = makeHarness(namedTree());
    const before = h.styleOf("named_b").color;

    new ComparisonOperator({
      enabled: true,
      mode: "membership",
      keyOf: keyByName,
      differing: [],
      equalColor: "#00ff00",
    }).attach(h.viewer);
    h.render();

    expect(h.styleOf("named_b").color).toBe(before);
  });

  it("accepts a predicate as well as a set", () => {
    const h = makeHarness(namedTree());
    new ComparisonOperator({
      enabled: true,
      mode: "membership",
      keyOf: keyByName,
      isDifferent: (key) => key === "c",
      equalColor: "#00ff00",
    }).attach(h.viewer);
    h.render();

    expect(h.styleOf("named_c").color).not.toBe("#00ff00"); // differs
    expect(h.styleOf("named_a").color).toBe("#00ff00"); // shared
  });

  it("updates when the differing set is replaced", () => {
    const h = makeHarness(namedTree());
    const cmp = new ComparisonOperator({
      enabled: true,
      mode: "membership",
      keyOf: keyByName,
      differing: [],
      equalColor: "#00ff00",
    });
    cmp.attach(h.viewer);
    h.render();
    expect(h.styleOf("named_a").color).toBe("#00ff00");

    cmp.setDiffering(["a"]);
    expect(h.styleOf("named_a").color).not.toBe("#00ff00");
  });

  it("does not color branches in membership mode", () => {
    const h = makeHarness(namedTree());
    const before = h.edgeStyleOf("named_a")!.color;

    new ComparisonOperator({
      enabled: true,
      mode: "membership",
      keyOf: keyByName,
      values: new Map([["a", 1]]),
      differing: [],
    }).attach(h.viewer);
    h.render();

    expect(h.edgeStyleOf("named_a")!.color).toBe(before);
  });
});

describe("ComparisonOperator — linking", () => {
  it("links two operators without throwing", () => {
    const left = makeHarness(namedTree());
    const right = makeHarness(namedTree());
    const a = new ComparisonOperator({ enabled: true });
    const b = new ComparisonOperator({ enabled: true });
    a.attach(left.viewer);
    b.attach(right.viewer);

    expect(() => {
      a.link(b);
      b.link(a);
    }).not.toThrow();
  });

  it("highlightByKey targets the matching node in the peer", () => {
    const left = makeHarness(namedTree());
    const right = makeHarness(namedTree());
    const a = new ComparisonOperator({ enabled: true, keyOf: keyByName });
    const b = new ComparisonOperator({ enabled: true, keyOf: keyByName });
    a.attach(left.viewer);
    b.attach(right.viewer);
    left.render();
    right.render();
    a.link(b);

    expect(() => a.highlightByKey("c")).not.toThrow();
  });
});

describe("moving the gradient between branches and markers", () => {
  it("stops colouring branches when edges are switched off, without losing the values", () => {
    const h = makeHarness(namedTree());
    const cmp = new ComparisonOperator({
      enabled: true,
      values: new Map([["a", 0], ["c", 1]]),
      keyOf: keyByName,
      scale: new SequentialColorScale({ stops: ["#000000", "#ffffff"] }),
    });
    cmp.attach(h.viewer);
    h.render();
    const colored = h.edgeStyleOf("named_c")!.color;

    cmp.setColorTargets({ edges: false });
    expect(h.edgeStyleOf("named_c")!.color).not.toBe(colored);

    // The operator was not disabled, only redirected: switching back restores
    // the same colour rather than needing the values to be fed again.
    cmp.setColorTargets({ edges: true });
    expect(h.edgeStyleOf("named_c")!.color).toBe(colored);
  });

  it("reports what it is currently colouring, and leaves the other target alone", () => {
    const cmp = new ComparisonOperator({ enabled: true });
    expect(cmp.getColorTargets()).toEqual({ edges: true, nodes: false });

    cmp.setColorTargets({ nodes: true });
    expect(cmp.getColorTargets()).toEqual({ edges: true, nodes: true });
  });
});

describe("pointing at a node the view is already arranged around", () => {
  it("can blink without moving the camera", () => {
    const h = makeHarness(namedTree());
    const cmp = new ComparisonOperator({ enabled: true, keyOf: keyByName });
    cmp.attach(h.viewer);
    h.render();
    const camera = h.viewer.getRenderer()!.getCamera();
    const before = { x: camera.x, y: camera.y, ratio: camera.ratio };

    cmp.highlightByKey("a", { center: false });

    // Centering zooms to 0.7, which on a freshly fitted subtree crops the
    // structure the node was worth pointing at within.
    expect({ x: camera.x, y: camera.y, ratio: camera.ratio }).toEqual(before);
  });
});

describe("how long a located node stays marked", () => {
  it("flashes the requested number of times, then stops marking it", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness(namedTree());
      const cmp = new ComparisonOperator({
        enabled: true,
        keyOf: keyByName,
        flashes: 5,
        flashInterval: 100,
      });
      cmp.attach(h.viewer);
      h.render();

      const lit = () => h.styleOf("named_a").color === "#ff0000";
      cmp.highlightByKey("a", { center: false });

      // On immediately, then dark and lit again on each pair of ticks.
      const seen: boolean[] = [lit()];
      for (let tick = 1; tick < 10; tick += 1) {
        vi.advanceTimersByTime(100);
        seen.push(lit());
      }
      expect(seen).toEqual([true, false, true, false, true, false, true, false, true, false]);
      // Five on-phases: the change is what draws the eye, so they are counted.
      expect(seen.filter(Boolean)).toHaveLength(5);

      // And it is over — a permanent mark would claim the node is special for
      // as long as the panel is open, when the view merely came here once.
      vi.advanceTimersByTime(1000);
      expect(lit()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
