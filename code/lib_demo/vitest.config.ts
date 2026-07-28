import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest configuration, kept separate from vite.config.ts so the app build and
 * the test run don't share settings they don't need.
 *
 * Tests default to the fast `node` environment; files that touch the DOM opt in
 * per-file with `// @vitest-environment jsdom`, so pure logic (tree model,
 * cache) doesn't pay the jsdom startup cost.
 */
export default defineConfig({
  root: __dirname,
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
    // Fail the run on an unhandled rejection rather than printing it and
    // passing — that is how the cache's registerPending bug stayed invisible.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
