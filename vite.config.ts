/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation headers. Required so `self.crossOriginIsolated` is
// true and `SharedArrayBuffer` is available — load-bearing for the SS6
// metering design (lock-free ring buffer shared with the audio thread).
// Both the dev server and `vite preview` need these: milestone e2e suites
// run against a production build served by `vite preview` (see
// playwright.config.ts's `webServer`), not against `vite dev`.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
