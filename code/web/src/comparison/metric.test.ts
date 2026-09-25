import { describe, expect, it } from "vitest";

import type { ComparisonSummary } from "../api/types";
import { headline, viewMetric } from "./metric";

describe("viewMetric", () => {
  it("reads a comparison under the metric it was computed with", () => {
    // The case that used to open to a 404: asking for rf regardless.
    expect(viewMetric({ metrics: ["triplet"] })).toBe("triplet");
    expect(viewMetric({ metrics: ["rf-treediff"] })).toBe("rf-treediff");
  });

  it("prefers rf where it was computed", () => {
    expect(viewMetric({ metrics: ["triplet", "rf"] })).toBe("rf");
  });

  it("falls back to rf only when the comparison names none", () => {
    expect(viewMetric({ metrics: [] })).toBe("rf");
  });
});

describe("headline", () => {
  const summary = (scalars: Record<string, number>) =>
    ({ summary: scalars }) as unknown as ComparisonSummary;

  it("shows RF, normalised where reported", () => {
    expect(headline(summary({ rf: 12, rf_normalised: 0.25 }))).toMatchObject({
      label: "RF", value: 12, normalised: 0.25,
    });
  });

  it("shows the triplet distance for a triplet comparison", () => {
    expect(headline(summary({ triplet: 40 }))).toMatchObject({ label: "Triplet", value: 40 });
  });

  it("shows nothing rather than an invented number", () => {
    expect(headline(summary({}))).toBeNull();
  });
});
