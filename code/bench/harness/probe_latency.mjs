/** Where PhyloDelta's time goes at the top of the ladder, per request. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";
import { start } from "./serve.mjs";

const BENCH = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const built = JSON.parse(readFileSync(join(BENCH, "results", "server_build.json"), "utf8"));
const PORT = 8099;
const server = await start(PORT);

for (const leaves of [17645, 282320]) {
  const rung = built.find((r) => r.leaves === leaves);
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const calls = [];
  page.on("requestfinished", async (req) => {
    const timing = req.timing();
    if (timing && timing.responseEnd > 0) {
      calls.push({
        url: req.url().replace(`http://localhost:${PORT}`, ""),
        ms: +(timing.responseEnd - timing.requestStart).toFixed(0),
      });
    }
  });

  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/#/c/${rung.id}`);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".side-counts")].filter((n) =>
        /showing/.test(n.textContent || ""),
      ).length === 2,
    { timeout: 120_000 },
  );
  const total = Date.now() - t0;

  const network = calls.reduce((sum, c) => sum + c.ms, 0);
  console.log(`\n${leaves.toLocaleString()} leaves — total ${total}ms, network ${network}ms across ${calls.length} requests`);
  for (const c of calls.sort((a, b) => b.ms - a.ms).slice(0, 6)) {
    console.log(`   ${String(c.ms).padStart(6)}ms  ${c.url.slice(0, 72)}`);
  }
  await browser.close();
}
server.close();
