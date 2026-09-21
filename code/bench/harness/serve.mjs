/**
 * Static server for the benchmark. Serves three roots under one origin so both
 * tools fetch trees from the same place and neither gets a cross-origin penalty
 * the other avoids:
 *
 *   /phyloio/dist/...  phylo.io's prebuilt bundle (upstream, untouched)
 *   /harness/...       our driver pages
 *   /trees/...         the generated tree ladder
 *
 * No compression: gzip would measure the server, not the browser, and the two
 * tools must be compared on identical transport.
 */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const BENCH = join(here, "..");
const PHYLOIO = "/Users/danielcarvalho/Documents/masters/Theses/examples/tools/phylo-io";

const ROOTS = {
  "/phyloio/": PHYLOIO,
  "/harness/": join(BENCH, "harness"),
  "/trees/": join(BENCH, "trees"),
};

// Everything not matching a prefix falls through to the demo's production
// build. It is served at the ORIGIN ROOT on purpose: its index.html references
// /assets/... absolutely, and its config fetches /gen_trees/... — serving it
// under a subpath would 404 both. The benchmark measures the shipping build,
// so it is served the way the build expects.
const DEMO = join(BENCH, "..", "lib_demo", "dist");

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".nwk": "text/plain",
  ".tsv": "text/tab-separated-values", ".map": "application/json",
};

export function start(port = 8099) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const prefix = Object.keys(ROOTS).find((p) => url.startsWith(p));
    // normalize() collapses any "..", so a crafted URL cannot escape the root.
    const file = prefix
      ? join(ROOTS[prefix], normalize(url.slice(prefix.length)))
      : join(DEMO, normalize(url === "/" ? "index.html" : url));
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store", // every run pays the same cost
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8099);
  await start(port);
  console.log(`serving on http://localhost:${port}/  (harness/ phyloio/ trees/)`);
}
