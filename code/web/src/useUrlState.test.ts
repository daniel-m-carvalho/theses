/**
 * The URL names what is on screen.
 *
 * Tested because the failure is silent and annoying rather than loud: a
 * refresh quietly dropping you back at the chooser looks like a design choice
 * until you have lost a view of two 500k-leaf trees for the third time.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "./test_support/renderHook";
import { useUrlState } from "./useUrlState";

describe("view state in the URL", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("starts empty when the URL names nothing", () => {
    const { result } = renderHook(() => useUrlState());
    expect(result.current[0].comparison).toBeNull();
  });

  it("round-trips a comparison and both navigation paths", () => {
    const { result } = renderHook(() => useUrlState());
    act(() => result.current[1]({ comparison: "a__b", left: [3, 900], right: [12] }));

    expect(window.location.hash).toBe("#/c/a__b?l=3%2C900&r=12");

    const restored = renderHook(() => useUrlState());
    expect(restored.result.current[0]).toEqual({
      comparison: "a__b",
      left: [3, 900],
      right: [12],
    });
  });

  it("omits empty paths rather than writing them", () => {
    const { result } = renderHook(() => useUrlState());
    act(() => result.current[1]({ comparison: "a__b", left: [], right: [] }));
    expect(window.location.hash).toBe("#/c/a__b");
  });

  it("encodes an id safely", () => {
    const { result } = renderHook(() => useUrlState());
    act(() => result.current[1]({ comparison: "a/b?c", left: [], right: [] }));
    const restored = renderHook(() => useUrlState());
    expect(restored.result.current[0].comparison).toBe("a/b?c");
  });

  it("ignores a hash it does not understand", () => {
    window.history.replaceState(null, "", "#something-else");
    const { result } = renderHook(() => useUrlState());
    expect(result.current[0].comparison).toBeNull();
  });

  it("does not add a history entry per expansion", () => {
    // Otherwise Back would mean "undo one expand" rather than "leave this
    // comparison", and escaping a deep navigation would take twenty presses.
    const { result } = renderHook(() => useUrlState());
    const before = window.history.length;
    act(() => result.current[1]({ comparison: "a__b", left: [1], right: [] }));
    act(() => result.current[1]({ comparison: "a__b", left: [1, 2], right: [] }));
    act(() => result.current[1]({ comparison: "a__b", left: [1, 2, 3], right: [] }));
    expect(window.history.length).toBe(before);
  });
});
