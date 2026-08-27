/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

// Shared e2e harness (M0), used by every later milestone's e2e suites.
//
// - deviceScaleFactor 2 so canvas rendering (piano roll, arrangement lanes,
//   §9/§10) is testable at a DPR where pixel-snapping bugs actually show up.
// - `--autoplay-policy=no-user-gesture-required` so the AudioContext can
//   start headlessly, without a synthetic user gesture per test.
// - webServer builds and serves a PRODUCTION build via `vite preview` (not
//   `vite dev`) — dev-only behavior (HMR, unminified output) should never be
//   what e2e asserts against, and `vite preview` is also where the SS6
//   metering COOP/COEP headers must hold (see vite.config.ts). It builds with
//   `--mode e2e` (`npm run build:e2e`): same production build, but the mode
//   flag is what enables the `window.__fabletonDemo` test bridge in
//   src/main.tsx, which must not exist in the shipped bundle.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 2,
        launchOptions: {
          args: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build:e2e && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Never reuse: this suite asserts against the BUILT bundle (the worklet
    // chunk check reads `dist/assets` directly, and the offline-render specs
    // need the `--mode e2e` bridge), so a stale server already on the port
    // would silently be asserted against instead of the current source. With
    // `strictPort` a leftover server fails loudly rather than passing wrongly.
    reuseExistingServer: false,
    timeout: 180_000,
    // `npm run build` typechecks the whole repo first (package.json), so a tsc
    // error anywhere — including in an e2e spec being iterated on — kills the
    // server. Without these, Playwright reports only "Process from
    // config.webServer was not able to start. Exit code: 2" and the actual
    // error is invisible unless you know to set DEBUG=pw:webserver.
    stdout: "pipe",
    stderr: "pipe",
  },
});
