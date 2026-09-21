import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "./cache_manager";

const mgr = (budgetBytes: number, cbs = {}) =>
  new CacheManager<string>({ budgetBytes, ...cbs });

describe("basic get / set / has", () => {
  it("stores and retrieves a value", () => {
    const c = mgr(100);
    c.set("a", "A", 10);
    expect(c.has("a")).toBe(true);
    expect(c.get("a")).toBe("A");
  });

  it("returns null on a miss and reports absence", () => {
    const c = mgr(100);
    expect(c.get("nope")).toBeNull();
    expect(c.has("nope")).toBe(false);
  });

  it("tracks byte usage and entry counts", () => {
    const c = mgr(100);
    c.set("a", "A", 10);
    c.set("b", "B", 15);
    expect(c.currentBytes).toBe(25);
    expect(c.entryCount).toBe(2);
    expect(c.warmCount).toBe(2);
    expect(c.renderedCount).toBe(0);
  });

  it("replaces an existing key without double-counting its bytes", () => {
    const c = mgr(100);
    c.set("a", "A", 10);
    c.set("a", "A2", 30); // same key, larger payload
    expect(c.entryCount).toBe(1);
    expect(c.currentBytes).toBe(30); // 30, not 40
    expect(c.get("a")).toBe("A2");
  });

  it("rejects an entry larger than the whole budget", () => {
    const c = mgr(50);
    expect(() => c.set("huge", "X", 51)).toThrow(RangeError);
  });

  it("deletes entries and reclaims their bytes", () => {
    const c = mgr(100);
    c.set("a", "A", 10);
    c.delete("a");
    expect(c.has("a")).toBe(false);
    expect(c.currentBytes).toBe(0);
    c.delete("ghost"); // no-op, must not throw or go negative
    expect(c.currentBytes).toBe(0);
  });
});

describe("LRU eviction", () => {
  it("evicts the least recently used warm entry first", () => {
    const c = mgr(30);
    c.set("a", "A", 10);
    c.set("b", "B", 10);
    c.set("c", "C", 10); // full
    c.get("a"); // 'a' becomes most recent, so 'b' is now the LRU
    c.set("d", "D", 10); // over budget -> evict one

    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.has("c")).toBe(true);
    expect(c.has("d")).toBe(true);
    expect(c.currentBytes).toBeLessThanOrEqual(30);
  });

  it("fires onEvict with the evicted key and value", () => {
    const onEvict = vi.fn();
    const c = new CacheManager<string>({ budgetBytes: 20, onEvict });
    c.set("a", "A", 10);
    c.set("b", "B", 10);
    c.set("c", "C", 10); // evicts 'a'

    expect(onEvict).toHaveBeenCalledWith("a", "A");
    expect(c.has("a")).toBe(false);
  });

  it("evicts repeatedly until back under budget", () => {
    const c = mgr(30);
    c.set("a", "A", 10);
    c.set("b", "B", 10);
    c.set("c", "C", 10);
    c.set("big", "BIG", 30); // needs the whole budget

    expect(c.currentBytes).toBeLessThanOrEqual(30);
    expect(c.has("big")).toBe(true);
  });
});

describe("warm / rendered tiers", () => {
  it("protects rendered entries from eviction while warm ones remain", () => {
    const c = mgr(30);
    c.set("keep", "K", 10);
    c.promote("keep"); // rendered -> protected
    c.set("a", "A", 10);
    c.set("b", "B", 10);
    c.set("c", "C", 10); // over budget -> must evict warm, not 'keep'

    expect(c.has("keep")).toBe(true);
    expect(c.renderedCount).toBe(1);
  });

  it("falls back to evicting rendered entries when nothing warm is left", () => {
    const c = mgr(20);
    c.set("a", "A", 10);
    c.promote("a");
    c.set("b", "B", 10);
    c.promote("b");
    expect(c.renderedCount).toBe(2);

    c.set("c", "C", 10); // nothing warm to drop -> a rendered entry must go
    expect(c.currentBytes).toBeLessThanOrEqual(20);
    expect(c.entryCount).toBe(2);
  });

  it("fires onPromote and onDemote across tier moves", () => {
    const onPromote = vi.fn();
    const onDemote = vi.fn();
    const c = new CacheManager<string>({ budgetBytes: 100, onPromote, onDemote });

    c.set("a", "A", 10);
    c.promote("a");
    expect(onPromote).toHaveBeenCalledWith("a", "A");
    expect(c.renderedCount).toBe(1);
    expect(c.warmCount).toBe(0);

    c.demote("a");
    expect(onDemote).toHaveBeenCalledWith("a", "A");
    expect(c.renderedCount).toBe(0);
    expect(c.warmCount).toBe(1);
  });

  it("re-fires onPromote when a rendered entry's value is updated", () => {
    // So the caller can push the new value to its renderer without a 2nd call.
    const onPromote = vi.fn();
    const c = new CacheManager<string>({ budgetBytes: 100, onPromote });
    c.set("a", "A", 10);
    c.promote("a");
    onPromote.mockClear();

    c.set("a", "A2", 10);
    expect(onPromote).toHaveBeenCalledWith("a", "A2");
  });

  it("treats promote/demote as no-ops for missing or same-tier keys", () => {
    const onPromote = vi.fn();
    const c = new CacheManager<string>({ budgetBytes: 100, onPromote });
    c.promote("ghost");
    c.demote("ghost");
    c.set("a", "A", 10);
    c.demote("a"); // already warm
    expect(onPromote).not.toHaveBeenCalled();

    c.promote("a");
    c.promote("a"); // already rendered -> only one callback
    expect(onPromote).toHaveBeenCalledTimes(1);
  });
});

describe("pending fetches", () => {
  it("tracks an in-flight promise and clears it on resolve", async () => {
    const c = mgr(100);
    const p = c.registerPending("a", Promise.resolve("done"));
    expect(c.isPending("a")).toBe(true);

    await p;
    await Promise.resolve(); // let the finally() microtask run
    expect(c.isPending("a")).toBe(false);
  });

  it("clears a pending entry on rejection too", async () => {
    const c = mgr(100);
    const p = c.registerPending("a", Promise.reject(new Error("boom")));
    expect(c.isPending("a")).toBe(true);

    await expect(p).rejects.toThrow("boom");
    await Promise.resolve();
    expect(c.isPending("a")).toBe(false);
  });
});

describe("clear", () => {
  it("resets entries, tiers and byte accounting", () => {
    const c = mgr(100);
    c.set("a", "A", 10);
    c.set("b", "B", 10);
    c.promote("a");
    c.registerPending("c", Promise.resolve(1));

    c.clear();
    expect(c.entryCount).toBe(0);
    expect(c.warmCount).toBe(0);
    expect(c.renderedCount).toBe(0);
    expect(c.currentBytes).toBe(0);
    expect(c.isPending("c")).toBe(false);
    expect(c.get("a")).toBeNull();
  });
});
