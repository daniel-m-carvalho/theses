import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom for the hooks that touch window.location and the DOM; the pure
    // modules do not care either way.
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
