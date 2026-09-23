/**
 * How much detail to ask for.
 *
 * The budget is a property of the viewport, not a constant: asking the server
 * for more than the client can draw is this project's central failure in
 * miniature — the request succeeds, the bytes arrive, and the picture is
 * worse.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, readableBudget } from "./useSide";

describe("readableBudget", () => {
  it("waits rather than guessing before the panel is measured", () => {
    // A placeholder budget would mean two slices per panel on every load:
    // one for a picture nobody sees, then the real one.
    expect(readableBudget(0)).toBe(0);
  });

  it("scales with the height available", () => {
    expect(readableBudget(600)).toBeLessThan(readableBudget(1200));
  });

  it("leaves enough pixels per leaf for the structure to be visible", () => {
    // The bug this replaced: a fixed 400 in a 577px panel is 1.4px a leaf, and
    // the terminals — which a cladogram pins to one column — fused into a
    // solid bar with a block of colour beside it.
    for (const height of [400, 577, 800, 1200]) {
      expect(height / readableBudget(height)).toBeGreaterThanOrEqual(5);
    }
  });

  it("is quantised, so settling layout does not cost a request", () => {
    // Measured on load: the panel reported 600px, then 577px. Both should ask
    // for the same slice.
    expect(readableBudget(600)).toBe(readableBudget(577));
  });

  it("stays usable in a very small or very large window", () => {
    expect(readableBudget(50)).toBeGreaterThanOrEqual(40);
    expect(readableBudget(20_000)).toBeLessThanOrEqual(600);
  });

  it("has a default for the unmeasured case that is itself readable", () => {
    expect(DEFAULT_BUDGET).toBeGreaterThan(40);
    expect(DEFAULT_BUDGET).toBeLessThan(600);
  });
});
