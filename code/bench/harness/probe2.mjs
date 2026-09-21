/** Re-probe with CDP memory + the maxNodes sweep, on the real vibrio pair. */
import { chromium } from "playwright";
import { start } from "./serve.mjs";
import { attach, snapshot, delta } from "./metrics_cdp.mjs";

const PORT = 8099;
const L = "/gen_trees/vibrio-upgma-tree.nwk", R = "/gen_trees/vibrio-nj-tree.nwk";
const server = await start(PORT);
const browser = await chromium.launch();
const show = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +Number(v).toFixed(1)]));

async function phyloio() {
  const page = await browser.newPage();
  const client = await attach(page);
  await page.goto(`http://localhost:${PORT}/harness/phyloio.html`);
  await page.waitForFunction(() => window.__benchReady === true);
  const before = await snapshot(client);
  const phases = await page.evaluate(([l, r]) => window.__bench.load(l, r), [L, R]);
  const after = await snapshot(client);
  await page.close();
  return { phases: show(phases), mem: delta(before, after) };
}

async function demo(maxNodes) {
  const page = await browser.newPage();
  const client = await attach(page);
  await page.goto("about:blank");
  const before = await snapshot(client);
  await page.goto(`http://localhost:${PORT}/?left=${L}&right=${R}&isolates=0&maxNodes=${maxNodes}`);
  await page.waitForFunction(() => window.__demoPainted === true, { timeout: 180_000 });
  const after = await snapshot(client);
  const phases = await page.evaluate(() => window.__demoPhases);
  const stats = await page.evaluate(() => window.__demoStats);
  await page.close();
  const post = (phases.parse ?? 0) + (phases.layout ?? 0) + (phases.paint ?? 0);
  return { phases: show({ ...phases, postFetch: post }), mem: delta(before, after), stats };
}

try {
  const p = await phyloio();
  console.log("phylo.io");
  console.log("   phases:", p.phases);
  console.log("   memory:", p.mem);
  for (const n of ["50", "1000", "unlimited"]) {
    const d = await demo(n);
    console.log(`\nlib_demo  maxNodes=${n}`);
    console.log("   phases:", d.phases);
    console.log("   memory:", d.mem);
    console.log("   rendered:", d.stats);
  }
} finally {
  await browser.close();
  server.close();
}
