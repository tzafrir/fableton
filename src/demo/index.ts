// M0's proof: a hard-coded clip audible through a hard-coded chain. See
// ./engine.ts for the wiring (params + device host + transport) and
// ./offlineRender.ts for the SS15 headless (real-browser) non-silence proof;
// src/app/App.tsx is the only caller of `createDemoEngine` inside the live
// app, and src/main.tsx is what exposes `renderDemoOffline` to e2e/.

export { DEMO_BPM, DEMO_CLIP, DEMO_TRACK_ID } from "./clip";
export { instrumentToNoteTarget } from "./noteTarget";

export {
  DEMO_CUTOFF_PARAM_ID,
  DEMO_SYNTH_GAIN_DB,
  DEMO_TEMPO_MAP,
  createDemoEngine,
  demoClipDurationSeconds,
} from "./engine";
export type { CreateDemoEngineOptions, DemoEngine } from "./engine";

export { RMS_WINDOW_SECONDS, analyze, renderDemoOffline } from "./offlineRender";
export type { AnalyzableBuffer, BufferAnalysis, OfflineRenderResult } from "./offlineRender";
