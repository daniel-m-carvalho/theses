/**
 * Day-1 de-risking spike: can phylo.io be driven headlessly at all?
 * Everything downstream depends on this, so it runs first and alone.
 */
import { launch } from "./browser.mjs";
import { start } from "./serve.mjs";

const PORT = 8099;
const server = await start(PORT);
const browser = await launch();
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

try {
  await page.goto(`http://localhost:${PORT}/harness/phyloio.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__benchReady === true, { timeout: 15_000 });
  console.log("  bundle loaded, PhyloIO global:", await page.evaluate(() => typeof PhyloIO));

  const timing = await page.evaluate(() =>
    window.__bench.load("/trees/smoke_a.nwk", "/trees/smoke_b.nwk")
  );
  console.log("  phases(ms):", Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, +v.toFixed(1)])));

  // Did it actually paint? phylo.io renders SVG, so count the drawn elements.
  const drawn = await page.evaluate(() => ({
    svg: document.querySelectorAll("svg").length,
    paths: document.querySelectorAll("path").length,
    texts: document.querySelectorAll("text").length,
  }));
  console.log("  rendered:", drawn);
  console.log(drawn.paths > 0 || drawn.texts > 0 ? "\n  PASS — phylo.io renders headlessly" : "\n  FAIL — nothing drawn");
} finally {
  if (errors.length) console.log("\n  page errors:\n" + errors.slice(0, 8).map((e) => "    " + e).join("\n"));
  await browser.close();
  server.close();
}
