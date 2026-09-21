/**
 * Memory and DOM measurement via the Chrome DevTools Protocol.
 *
 * `performance.memory` is not usable for this: Chrome quantises it for security
 * and it is GC-dependent, which is why a probe run reported phylo.io using
 * 22 MB before and 22 MB after building 2,002 SVG elements. Memory is half the
 * thesis claim, so it is measured through CDP instead:
 *
 *   Runtime.getHeapUsage    — JS heap actually in use
 *   Memory.getDOMCounters   — live DOM nodes, listeners, JS event handlers
 *   Performance.getMetrics  — Chrome's own counters, incl. layout/recalc totals
 *
 * Every reading is taken after a forced GC (`HeapProfiler.collectGarbage`), so
 * what is reported is retained memory rather than whatever garbage happened to
 * be uncollected at that instant. Without that, results vary by tens of MB
 * between identical runs.
 */

/** Attach a CDP session and enable the domains we read from. */
export async function attach(page) {
  const client = await page.context().newCDPSession(page);
  await Promise.all([
    client.send("Performance.enable"),
    client.send("HeapProfiler.enable"),
  ]);
  return client;
}

/**
 * Retained JS heap in bytes, after a forced collection.
 * Falls back to the un-collected reading if GC is unavailable.
 */
export async function heapBytes(client) {
  try {
    await client.send("HeapProfiler.collectGarbage");
  } catch {
    /* not fatal — the reading is just noisier */
  }
  const { usedSize } = await client.send("Runtime.getHeapUsage");
  return usedSize;
}

/** Live DOM node count, listeners and document count. */
export async function domCounters(client) {
  const { documents, nodes, jsEventListeners } = await client.send("Memory.getDOMCounters");
  return { documents, nodes, jsEventListeners };
}

/** Chrome's own performance counters, as a flat object. */
export async function chromeMetrics(client) {
  const { metrics } = await client.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/**
 * A full snapshot: heap, DOM and the Chrome counters that matter for
 * "responsiveness and smoothness" — cumulative layout, style recalc and script
 * time. Taken once before the tree loads and once after it has painted; the
 * difference is what the tree cost.
 */
export async function snapshot(client) {
  const [heap, dom, chrome] = await Promise.all([
    heapBytes(client),
    domCounters(client),
    chromeMetrics(client),
  ]);
  return {
    heapBytes: heap,
    domNodes: dom.nodes,
    jsEventListeners: dom.jsEventListeners,
    layoutMs: (chrome.LayoutDuration ?? 0) * 1000,
    recalcStyleMs: (chrome.RecalcStyleDuration ?? 0) * 1000,
    scriptMs: (chrome.ScriptDuration ?? 0) * 1000,
  };
}

/** Difference between two snapshots, i.e. what the measured work actually cost. */
export function delta(before, after) {
  return {
    heapMB: +((after.heapBytes - before.heapBytes) / 1048576).toFixed(2),
    heapPeakMB: +(after.heapBytes / 1048576).toFixed(2),
    domNodes: after.domNodes - before.domNodes,
    jsEventListeners: after.jsEventListeners - before.jsEventListeners,
    layoutMs: +(after.layoutMs - before.layoutMs).toFixed(1),
    recalcStyleMs: +(after.recalcStyleMs - before.recalcStyleMs).toFixed(1),
    scriptMs: +(after.scriptMs - before.scriptMs).toFixed(1),
  };
}
