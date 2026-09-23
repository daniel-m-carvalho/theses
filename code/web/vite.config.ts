import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The dev server proxies /api to the backend.
 *
 * Not because CORS would block it — the API allows every origin, since its
 * credentials are bearer tokens a browser never attaches by itself — but
 * because it keeps one origin in development and in the container, so the
 * client never needs to know where the backend lives.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PHYLODELTA_API ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
