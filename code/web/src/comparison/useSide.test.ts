/**
 * How much detail to ask for.
 *
 * The budget is a property of the viewport, not a constant: asking the server
 * for more than the client can draw is this project's central failure in
 * miniature — the request succeeds, the bytes arrive, and the picture is
 * worse.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../api/client";
import { actAsync, renderHook } from "../test_support/renderHook";
import { DEFAULT_BUDGET, readableBudget, useSide } from "./useSide";

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

describe("arriving from the other panel", () => {
  const leaf = 3296;

  function runJump(ancestor: typeof api.ancestor) {
    vi.spyOn(api, "ancestor").mockImplementation(ancestor);
    // The slice itself is not under test here; keep it from touching the
    // network so only the widening decides what happens.
    vi.spyOn(api, "slice").mockImplementation(
      () => new Promise(() => {}) as ReturnType<typeof api.slice>,
    );
    return renderHook(() => useSide("vibrio-upgma", "a__b"));
  }

  afterEach(() => vi.restoreAllMocks());

  it("roots at the widened ancestor and keeps the node drawn", async () => {
    const { result } = runJump(async () => ({
      node: 3266,
      leaves: 20,
      climbed: 12,
      reached_root: false,
    }));

    await actAsync(() => result.current[1].focusWithContext(leaf));

    expect(result.current[0].path).toEqual([3266]);
  });

  it("does not move the view when the widening fails", async () => {
    // What shipped: the failure silently fell back to focusing the bare node,
    // so when the running server predated /ancestor every jump 404'd and
    // rooted the panel at a single leaf — the exact symptom the endpoint was
    // added to remove, with nothing on screen to say a call had failed.
    const { result } = runJump(async () => {
      throw new ApiError(404, { code: "not_found", detail: "No such route" });
    });

    await actAsync(() => result.current[1].focusWithContext(leaf));

    expect(result.current[0].path).toEqual([]);
    expect(result.current[0].error).toMatch(/where 3296 sits/);
  });
});
