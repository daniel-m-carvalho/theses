/**
 * Does lib_demo have the same scaling problem as phylo.io?
 * Run both on the REAL vibrio pair (17,646 leaves) and compare phases + heap.
 */
import { chromium } from "playwright";
import { start } from "./serve.mjs";

const PORT = 8099;
const LEFT = "/gen_trees/vibrio-upgma-tree.nwk";
const RIGHT = "/gen_trees/vibrio-nj-tree.nwk";
const server = await start(PORT);
const browser = await chromium.launch();

const heapMB = async (page) => {
  const m = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  return +(m / 1048576).toFixed(1);
};
const show = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +Number(v).toFixed(1)]));

try {
  // --- phylo.io ---
  {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`http://localhost:${PORT}/harness/phyloio.html`);
    await page.waitForFunction(() => window.__benchReady === true);
    const before = await heapMB(page);
    const t0 = Date.now();
    let phases = null, failed = null;
    try {
      phases = await page.evaluate(([l, r]) => window.__bench.load(l, r), [LEFT, RIGHT]);
    } catch (e) { failed = e.message.split("\n")[0]; }
    const wall = Date.now() - t0;
    const after = await heapMB(page);
    const svg = await page.evaluate(() => document.querySelectorAll("path,text,circle,line").length);
    console.log("phylo.io  (renders every node as SVG)");
    console.log("   phases:", phases ? show(phases) : `FAILED after ${wall} ms: ${failed}`);
    console.log(`   heap: ${before} -> ${after} MB   SVG elements drawn: ${svg.toLocaleString()}`);
    if (errs.length) console.log("   errors:", errs.slice(0, 2));
    await page.close();
  }

  // --- lib_demo ---
  {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/?left=${LEFT}&right=${RIGHT}&isolates=0`);
    let ok = true;
    try { await page.waitForFunction(() => window.__demoPainted === true, { timeout: 120_000 }); }
    catch { ok = false; }
    const wall = Date.now() - t0;
    const phases = await page.evaluate(() => window.__demoPhases);
    const heap = await heapMB(page);
    const dom = await page.evaluate(() => document.querySelectorAll("div,canvas").length);
    console.log("\nlib_demo  (parses all, renders maxNodes=50 via WebGL)");
    console.log("   phases:", show(phases), ok ? "" : `(TIMEOUT after ${wall} ms)`);
    console.log(`   heap after: ${heap} MB   DOM elements: ${dom.toLocaleString()}`);
    if (errs.length) console.log("   errors:", errs.slice(0, 2));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
