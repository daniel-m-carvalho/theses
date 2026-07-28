// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BarChartPresenter } from "./barchart_presenter";
import { CategoricalColorScale } from "../color/color_scale";
import { makeHarness, namedTree } from "./harness";
import type { LeafDatum } from "../data/leaf_data";

/** Count the bar elements currently drawn in the presenter's overlay. */
function barCount(container: HTMLElement): number {
  // Bars are flex containers; labels are plain divs with text.
  return container.querySelectorAll('div[style*="display: flex"]').length;
}

const data = (): Map<string, LeafDatum> =>
  new Map([
    ["a", { segments: [{ key: "PT", value: 3 }, { key: "ES", value: 1 }] }],
    ["c", { total: 10 }],
    ["d", { total: 5 }],
  ]);

describe("BarChartPresenter", () => {
  it("draws one bar per leaf that has data", () => {
    const h = makeHarness(namedTree());
    new BarChartPresenter({ data: data() }).attach(h.viewer);
    h.render();

    expect(barCount(h.container)).toBe(3); // a, c, d
  });

  it("draws no bar for a leaf with no data, rather than inventing one", () => {
    const h = makeHarness(namedTree());
    new BarChartPresenter({ data: new Map([["a", { total: 1 }]]) }).attach(h.viewer);
    h.render();

    expect(barCount(h.container)).toBe(1); // only 'a'; c and d get nothing
  });

  it("renders one segment per category in a composition", () => {
    const h = makeHarness(namedTree());
    new BarChartPresenter({ data: data() }).attach(h.viewer);
    h.render();

    const bars = h.container.querySelectorAll('div[style*="display: flex"]');
    const segmentCounts = [...bars].map((b) => b.children.length);
    expect(segmentCounts).toContain(2); // 'a' has PT + ES
  });

  it("resolves data through dataOf when the map misses", () => {
    const h = makeHarness(namedTree());
    new BarChartPresenter({ dataOf: (id) => (id === "c" ? { total: 4 } : undefined) }).attach(
      h.viewer
    );
    h.render();

    expect(barCount(h.container)).toBe(1);
  });

  it("supports the counts shorthand", () => {
    const h = makeHarness(namedTree());
    new BarChartPresenter({ counts: new Map([["a", 2], ["c", 3]]) }).attach(h.viewer);
    h.render();

    expect(barCount(h.container)).toBe(2);
  });

  it("toggles visibility without losing the bars", () => {
    const h = makeHarness(namedTree());
    const bars = new BarChartPresenter({ data: data() });
    bars.attach(h.viewer);
    h.render();

    bars.setEnabled(false);
    expect(bars.isEnabled()).toBe(false);
    bars.setEnabled(true);
    expect(barCount(h.container)).toBe(3);
  });

  it("switches scale without rebuilding", () => {
    const h = makeHarness(namedTree());
    const bars = new BarChartPresenter({ data: data() });
    bars.attach(h.viewer);
    h.render();

    bars.setScale("log");
    expect(bars.getScale()).toBe("log");
    expect(barCount(h.container)).toBe(3);
  });

  it("exposes the shared color scale for legends", () => {
    const shared = new CategoricalColorScale();
    const bars = new BarChartPresenter({ colorScale: shared });
    expect(bars.getColorScale()).toBe(shared);
  });

  it("removes its overlay on detach", () => {
    const h = makeHarness(namedTree());
    const bars = new BarChartPresenter({ data: data() });
    bars.attach(h.viewer);
    h.render();
    expect(barCount(h.container)).toBeGreaterThan(0);

    bars.detach();
    expect(barCount(h.container)).toBe(0);
  });

  it("re-attaches its overlay after a re-render (Sigma empties the container)", () => {
    const h = makeHarness(namedTree());
    new BarChartPresenter({ data: data() }).attach(h.viewer);
    h.render();
    h.container.innerHTML = ""; // simulate Sigma.kill() clearing the container
    h.render();

    expect(barCount(h.container)).toBe(3);
  });
});

describe("BarChartPresenter — metadata filter (README §8.2 / §9.4)", () => {
  const filterable = () => ({
    name: "root",
    branchset: [
      { name: "a", metadata: { country: "PT" } },
      { name: "c", metadata: { country: "ES" } },
      { name: "d", metadata: { country: "PT" } },
    ],
  });

  it("gives a filtered-out leaf no bar", () => {
    const h = makeHarness(filterable());
    new BarChartPresenter({
      data: new Map([["a", { total: 1 }], ["c", { total: 1 }], ["d", { total: 1 }]]),
    }).attach(h.viewer);
    h.render();
    expect(barCount(h.container)).toBe(3);

    h.setFilter((m) => m.country === "PT"); // drops 'c'
    expect(barCount(h.container)).toBe(2);
  });

  it("restores the bars when the filter is cleared", () => {
    const h = makeHarness(filterable());
    new BarChartPresenter({
      data: new Map([["a", { total: 1 }], ["c", { total: 1 }], ["d", { total: 1 }]]),
    }).attach(h.viewer);
    h.render();

    h.setFilter((m) => m.country === "PT");
    h.setFilter(null);
    expect(barCount(h.container)).toBe(3);
  });

  it("rescales bar lengths to the leaves still shown", () => {
    // The filtered-out leaf held the maximum, so the survivors should grow.
    const h = makeHarness(filterable());
    new BarChartPresenter({
      data: new Map([["a", { total: 1 }], ["c", { total: 100 }], ["d", { total: 1 }]]),
      maxBarWidth: 100,
    }).attach(h.viewer);
    h.render();
    h.afterRender();

    const widthOf = () => {
      const bars = [...h.container.querySelectorAll<HTMLElement>('div[style*="display: flex"]')];
      return parseFloat(bars[0].style.width);
    };
    const before = widthOf();

    h.setFilter((m) => m.country === "PT"); // removes the 100
    h.afterRender();
    expect(widthOf()).toBeGreaterThan(before);
  });
});
