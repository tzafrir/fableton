import { StrictMode } from "react";
import "./ui/theme/app.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import type { AppProjectEngine } from "./app/engine";
import { renderDemoOffline } from "./demo";
import { renderSpan } from "./export/renderProject";
import type { DocumentStore } from "./types";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

// e2e-only bridge (SS15: "the engine runs headless against
// OfflineAudioContext in integration tests ... assert on the buffer").
// jsdom has no Web Audio at all, so the real non-silence proof needs a real
// browser — this is what e2e/audio/offline-render.spec.ts calls into via
// Playwright's `page.evaluate`. See src/demo/offlineRender.ts.
//
// `engine` appears once the user has booted audio, so e2e/interaction/
// transport.spec.ts can watch the live transport's song position advance —
// which is what proves the SS12 worker clock keeps ticking past the first
// 200 ms look-ahead window in a real browser (and, in
// e2e/interaction/clock-worker.spec.ts, that the clock really is a dedicated
// Worker and not the main-thread fallback). M0's demo engine has been
// replaced by M1's real `ProjectEngine` (SS18-M1) — `transport`/`params`
// still have the same shape those two specs read, but
// e2e/interaction/param-control.spec.ts targeted the M0 demo's single
// exposed filter-cutoff slider, which no longer exists now that devices live
// on a real, editable document instead of one hard-coded chain; it is
// superseded pending M2's mixer/control-kit UI.
declare global {
  interface Window {
    __fabletonDemo?: {
      renderDemoOffline: typeof renderDemoOffline;
      engine?: AppProjectEngine;
      /** The live document + the PURE span math behind an export (SS12), so
       *  e2e/library's WAV test can assert the real frame count against what
       *  the document says it should be instead of "more than a second". */
      store?: DocumentStore;
      renderSpan: typeof renderSpan;
    };
  }
}
// ...and it is a TEST bridge, so it must not ship. Handing any script on the
// page the live `ParamRegistry` and `EngineTransport` would be an out-of-band
// route around the command/handle seam (SS3: "the parameter registry is the
// one deliberate bridge"). `import.meta.env` is statically replaced at build
// time, so the production bundle drops this branch — and with it every
// reference to `renderDemoOffline` — entirely.
//
// The e2e suite runs against a real production build, not `vite dev`, so it
// builds with `--mode e2e` (see `build:e2e` in package.json, used by
// playwright.config.ts's `webServer`); MODE is the only thing that differs
// from the shipped build.
const E2E_BRIDGE_ENABLED = import.meta.env.DEV || import.meta.env.MODE === "e2e";

const bridge: NonNullable<Window["__fabletonDemo"]> = { renderDemoOffline, renderSpan };
if (E2E_BRIDGE_ENABLED) {
  window.__fabletonDemo = bridge;
}

createRoot(container).render(
  <StrictMode>
    <App
      onEngineReady={(engine) => {
        if (E2E_BRIDGE_ENABLED) bridge.engine = engine;
      }}
      onStoreReady={(store) => {
        if (E2E_BRIDGE_ENABLED) bridge.store = store;
      }}
    />
  </StrictMode>
);
