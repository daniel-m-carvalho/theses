/** Day-1 spike, second half: does lib_demo drive headlessly on an arbitrary tree? */
import { chromium } from "playwright";
import { start } from "./serve.mjs";

const PORT = 8099;
const server = await start(PORT);
const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

try {
  const url = `http://localhost:${PORT}/?left=/trees/smoke_a.nwk&right=/trees/smoke_b.nwk&isolates=0`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__demoPainted === true, { timeout: 20_000 });
  const ms = Date.now() - t0;

  // The demo renders through Sigma/WebGL, so count canvases, not SVG paths.
  const phases = await page.evaluate(() => window.__demoPhases);
  console.log("  phases(ms):", Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, +v.toFixed(1)])));

  const drawn = await page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas").length,
    panels: document.querySelectorAll(".sigma-container").length,
    legend: (document.querySelector("#legend-values")?.textContent ?? "").slice(0, 40),
  }));
  console.log("  load->painted:", ms, "ms");
  console.log("  rendered:", drawn);
  console.log(drawn.canvases > 0 ? "\n  PASS — lib_demo renders headlessly on an injected tree" : "\n  FAIL");
} finally {
  if (errors.length) console.log("\n  page errors:\n" + errors.slice(0, 8).map((e) => "    " + e).join("\n"));
  await browser.close();
  server.close();
}
