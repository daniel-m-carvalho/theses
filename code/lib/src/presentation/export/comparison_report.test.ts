/**
 * What a comparison report says.
 *
 * This moved out of the application: the panels, the gradient, the wedges and
 * the bars are drawn here, so describing them belongs here too. These pin the
 * wording and the omissions, both of which are the point — a report that
 * silently drops a metric's scalars, or reports "not checked" as "no", is
 * worse than no report.
 */

import { describe, expect, it } from "vitest";
import { buildComparisonReport, type ComparisonReportInput } from "./comparison_report";

const base = (over: Partial<ComparisonReportInput> = {}): ComparisonReportInput => ({
  title: "vibrio-nj vs vibrio-upgma",
  panels: [
    { label: "vibrio-nj", showing: "showing 50 of 17,645 leaves" },
    { label: "vibrio-upgma", showing: "showing 50 of 17,646 leaves" },
  ],
  ...over,
});

const headings = (input: ComparisonReportInput) =>
  buildComparisonReport(input).sections.map((section) => section.heading);

const section = (input: ComparisonReportInput, heading: string) =>
  buildComparisonReport(input).sections.find((s) => s.heading === heading)!;

describe("structure", () => {
  it("omits what it was given nothing for", () => {
    // A report with an empty "Distance" heading claims a measurement was made.
    expect(headings(base())).toEqual([]);
  });

  it("orders panels, distance, reconciliation, then setup", () => {
    const all = headings(
      base({
        panels: [
          { label: "a", image: "data:image/png;base64,AA" },
          { label: "b", image: "data:image/png;base64,BB" },
        ],
        metric: { name: "rf", scalars: { rf: 6825 } },
        reconciliation: { sharedLeaves: 10, droppedFromLeft: 0, droppedFromRight: 0 },
        view: { gradient: true },
      }),
    );
    expect(all).toEqual([
      "Panels",
      "Distance (rf)",
      "Additional metric information",
      "View setup",
    ]);
  });

  it("names the metric it reports, and keeps every scalar it was given", () => {
    // Metrics differ; fixing the set would silently drop whatever a new one
    // adds.
    const fields = section(
      base({ metric: { name: "triplet", scalars: { triplet: 4.27e11, extra: "exact" } } }),
      "Distance (triplet)",
    ).fields!;
    expect(fields.map((f) => f.label)).toEqual(["triplet", "extra"]);
    expect(fields[1].value).toBe("exact");
  });
});

describe("reconciliation", () => {
  const recon = (over = {}) =>
    section(
      base({
        reconciliation: {
          sharedLeaves: 17_645,
          droppedFromLeft: 0,
          droppedFromRight: 1,
          labelMatch: "identity",
          sameSpecies: true,
          ...over,
        },
      }),
      "Additional metric information",
    ).fields!;

  it("says which side lost leaves, not just how many", () => {
    const dropped = recon().find((f) => f.label === "Dropped to reconcile")!;
    expect(dropped.value).toBe("1");
    expect(dropped.note).toBe("0 from vibrio-nj, 1 from vibrio-upgma");
  });

  it("says so plainly when nothing was dropped", () => {
    const dropped = recon({ droppedFromRight: 0 }).find(
      (f) => f.label === "Dropped to reconcile",
    )!;
    expect(dropped.note).toBe("the two trees have the same leaves");
  });

  it("reports an unchecked species as 'not declared', never as 'no'", () => {
    // "We did not check" must not read as "we checked and they differ".
    const field = recon({ sameSpecies: null }).find((f) => f.label === "Same species")!;
    expect(field.value).toBe("not declared");
    expect(field.note).toMatch(/could not be checked/);
  });

  it("sets a caution apart from the numbers", () => {
    const built = section(
      base({
        reconciliation: { sharedLeaves: 1, droppedFromLeft: 0, droppedFromRight: 0 },
        caution: "Matching is suspect.",
      }),
      "Additional metric information",
    );
    expect(built.caution).toBe("Matching is suspect.");
  });
});

describe("view setup", () => {
  it("names both ends of the divergence scale", () => {
    // The reader can see two clades differ; without this they cannot learn
    // what either colour means.
    const built = section(base({ view: { gradient: true } }), "View setup");
    expect(built.swatches).toHaveLength(2);
    expect(built.swatches![0].label).toMatch(/Identical/);
    expect(built.swatches![1].label).toMatch(/Diverged/);
  });

  it("names the third colour when the view had one", () => {
    // Branches with no value at all are not on the scale, so a key listing
    // only its two ends describes a picture the report does not contain.
    const built = section(
      base({ view: { gradient: true, absent: { label: "Not in the other tree", color: "#e03131" } } }),
      "View setup",
    );
    expect(built.swatches).toHaveLength(3);
    expect(built.swatches![2].label).toBe("Not in the other tree");
    expect(built.body!.join(" ")).toMatch(/not the same as a score of zero/);
  });

  it("says when colour carries no meaning", () => {
    const built = section(base({ view: { gradient: false } }), "View setup");
    expect(built.body!.join(" ")).toMatch(/carries no meaning/);
    expect(built.swatches).toHaveLength(0);
  });

  it("warns that several columns inflate the bars", () => {
    // The one thing a reader could not work out from the picture, and would
    // misread as "this leaf has more isolates".
    const built = section(
      base({
        view: {
          gradient: false,
          typing: { columns: ["Country", "Continent"], scale: "log" },
          legend: [{ label: "PT", color: "#f00" }],
        },
      }),
      "View setup",
    );
    expect(built.body!.join(" ")).toMatch(/counted once per column/);
    expect(built.body!.join(" ")).toMatch(/2× the isolate count/);
    expect(built.swatches!.some((s) => s.label === "PT")).toBe(true);
  });

  it("does not warn for a single column", () => {
    const built = section(
      base({ view: { gradient: false, typing: { columns: ["Country"], scale: "log" } } }),
      "View setup",
    );
    expect(built.body!.join(" ")).not.toMatch(/counted once per column/);
  });

  it("says when the leaves carry no bars at all", () => {
    const built = section(base({ view: { gradient: true, typing: null } }), "View setup");
    expect(built.body!.join(" ")).toMatch(/no bars/);
  });
});
