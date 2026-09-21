import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the library package.
 *
 * Tests default to the fast `node` environment; files that touch the DOM opt in
 * per-file with `// @vitest-environment jsdom`, so pure logic (tree model,
 * cache) doesn't pay the jsdom startup cost.
 *
 * No `__dirname` here: this package is `"type": "module"`, and Vitest resolves
 * both `include` and `setupFiles` relative to this file's directory.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Fail the run on an unhandled rejection rather than printing it and
    // passing — that is how the cache's registerPending bug stayed invisible.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
