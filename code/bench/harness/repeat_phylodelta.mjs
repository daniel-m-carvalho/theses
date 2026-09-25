/**
 * PhyloDelta, five times per rung.
 *
 * The ladder is n=1 per cell. For phylo.io that is defensible — 0.8s to 153s
 * is a shape no plausible noise invents. For PhyloDelta it is not: the numbers
 * are sub-second, so run-to-run variance is the same order as the measurement,
 * and the first ladder reported 2.7s and 3.6s at the top two rungs that a
 * direct probe could not reproduce (~30ms for the same API burst). Reporting
 * that as a degradation would have invented a limit the design does not have.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";
import { start } from "./serve.mjs";
import { attach, heapBytes } from "./metrics_cdp.mjs";

const BENCH = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const built = JSON.parse(readFileSync(join(BENCH, "results", "server_build.json"), "utf8"));
const PORT = 8098;
const REPEATS = 7;
//: The first sample of a rung is thrown away. A fresh Chrome's first page is
//: reliably the slowest thing it ever does, and that cost belongs to the
//: browser rather than to the tree being opened.
const WARMUP = 1;
const server = await start(PORT);
const out = [];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`\n${"leaves".padStart(9)} | ${"median".padStart(7)} | ${"min-max".padStart(13)} | heap`);
console.log("-".repeat(52));

for (const rung of built.filter((r) => r.status === "ready")) {
  const times = [];
  const heaps = [];
  const browser = await launch();
  for (let i = 0; i < REPEATS; i++) {
    // A fresh PAGE, not a fresh browser. Page isolation is what the
    // measurement needs — no cache, no retained heap — and 45 Chrome launches
    // were themselves the largest and most variable cost in the first attempt.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const client = await attach(page);
    const before = await heapBytes(client);
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/#/c/${rung.id}`);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".side-counts")].filter((n) =>
          /showing/.test(n.textContent || ""),
        ).length === 2,
      undefined,
      { timeout: 120_000 },
    );
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const elapsed = Date.now() - t0;
    const after = await heapBytes(client);
    await page.close();
    if (i < WARMUP) continue;
    times.push(elapsed);
    if (before !== null && after !== null) heaps.push((after - before) / 1e6);
  }
  await browser.close();
  const row = {
    leaves: rung.leaves,
    median_ms: median(times),
    min_ms: Math.min(...times),
    max_ms: Math.max(...times),
    samples: times,
    heap_mb: +median(heaps).toFixed(1),
  };
  out.push(row);
  writeFileSync(join(BENCH, "results", "phylodelta_repeats.json"), JSON.stringify(out, null, 2));
  console.log(
    `${rung.leaves.toLocaleString().padStart(9)} | ${(row.median_ms / 1000).toFixed(2).padStart(6)}s | ` +
      `${(row.min_ms / 1000).toFixed(2)}-${(row.max_ms / 1000).toFixed(2)}s`.padStart(13) +
      ` | ${row.heap_mb}MB`,
  );
}
server.close();
