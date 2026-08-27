// SS12 "Export" — "instantiate the same document on an `OfflineAudioContext`
// (reconciler already targets `BaseAudioContext`), run the scheduler in
// fill-everything mode, `startRendering()`, encode WAV."
//
// This is the SAME `createProjectEngine` the live app runs — reconciler,
// mixer params, sends, sidechains, automation sampler and all — pointed at
// an offline context. "Fill-everything mode" is the M0 pattern
// (src/demo/offlineRender.ts): a `ManualClock` ticked from `suspend()`
// callbacks every rendered tick-interval, so the look-ahead scheduler runs
// in its normal regime against the render clock. Browser-only by nature
// (jsdom has no OfflineAudioContext); e2e/export/ is what executes it.

import { DEFAULT_LOOKAHEAD_SECONDS, DEFAULT_TICK_INTERVAL_MS, PPQ } from "../types";
import type { ProjectSnapshot, Seconds, Ticks } from "../types";
import { createManualClock } from "../engine/transport";
import { createTempoMap } from "../time";
import { createProjectEngine } from "../app/engine";
import { encodeWav } from "./wav";

const RENDER_QUANTUM = 128;
/** Rendered past the last note so releases and reverb tails breathe. */
export const EXPORT_TAIL_SECONDS = 1.5;

/** Last tick any clip content reaches (loops count their clip length). */
export function contentEndTick(doc: ProjectSnapshot): Ticks {
  let end = 0;
  for (const clip of Object.values(doc.clips)) {
    end = Math.max(end, clip.start + clip.length);
  }
  return end;
}

export interface RenderProjectOptions {
  sampleRate?: number | undefined;
  /** Override the rendered span (song ticks). Defaults to [0, content end]. */
  fromTick?: Ticks | undefined;
  toTick?: Ticks | undefined;
}

export interface RenderedProject {
  buffer: AudioBuffer;
  durationSeconds: number;
  /** The engine ticks that ran during rendering (diagnostics). */
  ticks: number;
}

export async function renderProject(
  doc: ProjectSnapshot,
  options: RenderProjectOptions = {},
): Promise<RenderedProject> {
  const sampleRate = options.sampleRate ?? 44100;
  const tempo = createTempoMap(doc.tempo);
  const fromTick = options.fromTick ?? 0;
  const toTick = options.toTick ?? Math.max(contentEndTick(doc), fromTick + PPQ);
  const durationSeconds =
    Math.max(0.1, tempo.secondsBetween(fromTick, toTick)) + EXPORT_TAIL_SECONDS;

  const ctx = new OfflineAudioContext(2, Math.ceil(durationSeconds * sampleRate), sampleRate);
  const clock = createManualClock();
  const engine = createProjectEngine(ctx, ctx.destination, doc, {
    clock,
    lookAheadSeconds: DEFAULT_LOOKAHEAD_SECONDS,
    tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
    immediateReconcile: true,
  });
  // The full document — devices mounted, graph reconciled, values loaded —
  // must be live before the transport starts (worklet `prepare` awaits in
  // here, which is why export is async at all).
  await engine.applyDocument(doc);

  // The transport must not LOOP during an export: a bounded file is wanted.
  engine.transport.setLoop(null);

  const stepSeconds =
    (Math.max(1, Math.round(((DEFAULT_TICK_INTERVAL_MS / 1000) * sampleRate) / RENDER_QUANTUM)) *
      RENDER_QUANTUM) /
    sampleRate;
  let ticks = 0;
  for (let at: Seconds = stepSeconds; at < durationSeconds; at += stepSeconds) {
    void ctx.suspend(at).then(() => {
      ticks++;
      clock.tick();
      void ctx.resume();
    });
  }

  engine.transport.play(fromTick);
  const buffer = await ctx.startRendering();
  engine.dispose();
  return { buffer, durationSeconds, ticks };
}

/** Render + encode; the caller turns the bytes into a download. */
export async function renderProjectToWav(
  doc: ProjectSnapshot,
  options: RenderProjectOptions = {},
): Promise<{ wav: ArrayBuffer; durationSeconds: number }> {
  const { buffer, durationSeconds } = await renderProject(doc, options);
  return { wav: encodeWav(buffer), durationSeconds };
}
