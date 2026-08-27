// M0's proof: a hard-coded clip audible through a hard-coded chain. See
// ./engine.ts for the wiring (params + device host + transport) and
// ./offlineRender.ts for the SS15 headless (real-browser) non-silence proof.
//
// M1 UPDATE: the live app no longer plays any of this through a hard-coded
// chain. `src/app/App.tsx` runs the real `ProjectEngine`, whose instruments
// and clips come from the document (SS3) — `./project.ts` is M0's phrase
// re-expressed as a `Project`, and `src/app/persistence.ts` uses it as the
// first-run starter document, so the audible boot -> play path in the app
// (and in e2e/interaction/audio-graph.spec.ts) now runs entirely off the
// document. `./clip.ts` survives as the phrase's data and as the fixture
// `./engine.ts`/`./offlineRender.ts` still scan directly.
//
// What survives here otherwise is the offline render: `renderDemoOffline` is
// still the only place a full device CHAIN (synth -> filter) is wired,
// because M1 has no mixer/routing yet (M2 owns the reconciler, SS6), so it
// remains the buffer-level proof that `core.filter` sits in the audio path
// with its cutoff on fast path A. `src/main.tsx` exposes it to e2e/ behind
// the build-time test bridge.

export { DEMO_BPM, DEMO_CLIP, DEMO_TRACK_ID } from "./clip";
export { createDemoProject } from "./project";
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
