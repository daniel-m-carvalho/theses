// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  LEGEND_INLINE,
  openLegendDialog,
  renderComparisonLegend,
  renderLegend,
} from "./legend";

/**
 * The footer legend. What matters here is the *display* contract the user asked
 * for — a few entries inline, everything else behind "see more" — plus the two
 * ways a legend can lie: showing a colour the bars don't use, or omitting the
 * isolates that are counted but deliberately uncoloured.
 */

const colorOf = (value: string) => `#${value.length.toString(16).padStart(6, "0")}`;

function host(): HTMLElement {
  const el = document.createElement("footer");
  document.body.appendChild(el);
  return el;
}

function entries(n: number): Array<[string, number]> {
  return Array.from({ length: n }, (_, i) => [`value-${i}`, n - i] as [string, number]);
}

const items = (el: HTMLElement) => [...el.querySelectorAll(".legend-item")];
const moreButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button.legend-more");

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderLegend", () => {
  it("names the key being coloured, so the swatches mean something", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: entries(3), unrecorded: 0, colorOf });

    expect(el.querySelector(".legend-title")?.textContent).toBe("Country:");
  });

  it("shows every entry inline when they fit, with no 'see more'", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: entries(LEGEND_INLINE), unrecorded: 0, colorOf });

    expect(items(el)).toHaveLength(LEGEND_INLINE);
    expect(moreButton(el)).toBeNull();
  });

  it("caps inline entries and offers the rest behind 'see more'", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: entries(144), unrecorded: 0, colorOf });

    expect(items(el)).toHaveLength(LEGEND_INLINE); // not 144 in the footer
    expect(moreButton(el)?.textContent).toContain("144");
  });

  it("shows the most frequent values inline (the caller's order is respected)", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: entries(20), unrecorded: 0, colorOf });

    const labels = items(el).map((n) => n.textContent);
    expect(labels[0]).toContain("value-0"); // count 20, the largest
    expect(labels[labels.length - 1]).toContain(`value-${LEGEND_INLINE - 1}`);
  });

  it("colours each swatch from the library's scale, not its own guess", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: [["Spain", 4]], unrecorded: 0, colorOf });

    const swatch = el.querySelector<HTMLElement>(".swatch")!;
    // jsdom normalizes hex to rgb().
    expect(swatch.style.background).toBe("rgb(0, 0, 5)"); // colorOf("Spain") = #000005
  });

  it("reports counts alongside each value", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: [["Spain", 1234]], unrecorded: 0, colorOf });

    expect(el.textContent).toContain("1,234");
  });

  it("declares the uncoloured isolates, so short bars are explained", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: entries(2), unrecorded: 4137, colorOf });

    expect(el.textContent).toContain("4,137");
    expect(el.textContent).toMatch(/not recorded/i);
  });

  it("omits the note when nothing is unrecorded", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: entries(2), unrecorded: 0, colorOf });

    expect(el.textContent).not.toMatch(/not recorded/i);
  });

  it("says so plainly when the filter excludes everything", () => {
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: [], unrecorded: 0, colorOf });

    expect(items(el)).toHaveLength(0);
    expect(el.textContent).toMatch(/no isolates match/i);
  });

  it("replaces its contents on re-render rather than appending", () => {
    // It is repainted on every filter change; leftovers would double the legend.
    const el = host();
    renderLegend(el, { segmentBy: "Country", entries: entries(3), unrecorded: 0, colorOf });
    renderLegend(el, { segmentBy: "Continent", entries: entries(2), unrecorded: 0, colorOf });

    expect(items(el)).toHaveLength(2);
    expect(el.querySelector(".legend-title")?.textContent).toBe("Continent:");
  });
});

describe("renderComparisonLegend", () => {
  const base = {
    mode: "gradient" as const,
    stops: ["#2c7bb6", "#ffffbf", "#d7191c"],
    labels: ["different", "similar"] as [string, string],
    equalColor: "#0077bb",
    membershipLabel: "equal",
  };

  it("draws nothing when the comparison is off", () => {
    // No colouring on screen ⇒ no key for it in the footer.
    const el = host();
    renderComparisonLegend(el, { ...base, enabled: false });

    expect(el.innerHTML).toBe("");
  });

  it("draws the ramp with its end labels in gradient mode", () => {
    const el = host();
    renderComparisonLegend(el, { ...base, enabled: true });

    const ramp = el.querySelector<HTMLElement>(".gradient-ramp")!;
    expect(ramp).not.toBeNull();
    expect(ramp.style.background).toContain("linear-gradient");
    expect(el.textContent).toContain("different");
    expect(el.textContent).toContain("similar");
  });

  it("uses the configured stops, so the ramp matches the branches", () => {
    const el = host();
    renderComparisonLegend(el, { ...base, enabled: true, stops: ["#000000", "#ffffff"] });

    const ramp = el.querySelector<HTMLElement>(".gradient-ramp")!;
    // jsdom rewrites hex to rgb() inside the gradient.
    expect(ramp.style.background).toContain("rgb(0, 0, 0)");
    expect(ramp.style.background).toContain("rgb(255, 255, 255)");
  });

  it("shows a single swatch in membership mode", () => {
    // That mode paints agreement only, so a "different" swatch would advertise
    // a colour that never appears.
    const el = host();
    renderComparisonLegend(el, { ...base, enabled: true, mode: "membership" });

    expect(el.querySelector(".gradient-ramp")).toBeNull();
    expect(el.querySelectorAll(".swatch")).toHaveLength(1);
    expect(el.textContent).toContain("equal");
  });

  it("clears on re-render, so toggling off leaves nothing behind", () => {
    const el = host();
    renderComparisonLegend(el, { ...base, enabled: true });
    renderComparisonLegend(el, { ...base, enabled: false });

    expect(el.innerHTML).toBe("");
  });
});

describe("see-more dialog", () => {
  it("lists every value, not just the inline ones", () => {
    openLegendDialog("Country", entries(144), 0, colorOf);

    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelectorAll(".legend-row")).toHaveLength(144);
  });

  it("narrows the list by search without touching the data", () => {
    openLegendDialog("Country", entries(30), 0, colorOf);

    const dialog = document.querySelector("dialog")!;
    const search = dialog.querySelector<HTMLInputElement>("input[type=search]")!;
    search.value = "value-1";
    search.dispatchEvent(new Event("input"));

    const visible = [...dialog.querySelectorAll<HTMLElement>(".legend-row")].filter(
      (r) => r.style.display !== "none"
    );
    // value-1, value-10..value-19 — matching is a substring test, not a prefix.
    expect(visible).toHaveLength(11);
    // The rows are all still present: search hides, it never deletes.
    expect(dialog.querySelectorAll(".legend-row")).toHaveLength(30);
  });

  it("repeats the unrecorded note, since the dialog can be read on its own", () => {
    openLegendDialog("Country", entries(6), 99, colorOf);

    expect(document.querySelector("dialog")!.textContent).toContain("99");
  });

  it("removes itself from the DOM when closed", () => {
    openLegendDialog("Country", entries(6), 0, colorOf);
    const dialog = document.querySelector("dialog")!;

    dialog.dispatchEvent(new Event("close"));

    expect(document.querySelector("dialog")).toBeNull();
  });
});
