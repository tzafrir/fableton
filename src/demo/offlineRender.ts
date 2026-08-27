// The real-`OfflineAudioContext` render of the hard-coded demo chain — the
// SS15 testing-strategy proof: "the engine runs headless against
// `OfflineAudioContext` in integration tests (schedule a clip, render,
// assert on the buffer)".
//
// jsdom (Vitest's environment) ships no Web Audio implementation at all
// (see src/devices/harness/testing/fakeAudio.ts's header comment), so this
// module only runs in a real browser. `e2e/audio/offline-render.spec.ts` is
// what actually calls it, via `window.__fabletonDemo` (wired up in
// src/main.tsx), inside Playwright's headless Chromium — "headless" in the
// SS15 sense of "no human, no visible window", not "no browser engine at
// all", since a real `OfflineAudioContext` is unavoidably needed to render
// real samples.
//
// Everything downstream of `createDemoEngine` is written against
// `BaseAudioContext` (SS12), so this is the exact same wiring code that
// plays live audio in the browser — no separate "offline" chain to drift
// out of sync with the real one.

import { DEFAULT_LOOKAHEAD_SECONDS, DEFAULT_TICK_INTERVAL_MS } from "../types";
import { createManualClock } from "../engine/transport";
import {
  createDemoEngine,
  demoClipDurationSeconds,
  DEMO_CUTOFF_PARAM_ID,
} from "./engine";

/** Render quantum, so suspend times land on a boundary the spec allows. */
const RENDER_QUANTUM = 128;

/** Width of one `windowRms` slice — coarse enough to be cheap, fine enough
 *  that the demo clip's 250 ms eighth notes stay distinguishable. */
export const RMS_WINDOW_SECONDS = 0.05;

export interface OfflineRenderResult {
  sampleRate: number;
  durationSeconds: number;
  /** Largest absolute sample across every channel. */
  peakAbs: number;
  /** Root-mean-square level across every channel — 0 only for true silence. */
  rms: number;
  /** Samples whose magnitude exceeds full scale, i.e. what the destination
   *  would hard-clip. Must be 0: SS18-M0's audible proof should not distort. */
  clippedSamples: number;
  /** Per-`RMS_WINDOW_SECONDS` RMS, in order — the render's coarse envelope.
   *  Lets a test assert the clip is spread across time (every note scheduled
   *  at its own `AudioContext` timestamp, SS12) rather than one blast at 0. */
  windowRms: number[];
  /** Share of the render's energy sitting in the high end — see
   *  {@link BufferAnalysis.hfRatio}. Two renders differing only in the
   *  filter's cutoff must differ here, which is what proves `core.filter` is
   *  actually IN the audio path and bound to the right `AudioParam`. */
  hfRatio: number;
  /** The cutoff this render was made with, in Hz (`undefined` = the device's
   *  own default). */
  cutoffHz?: number;
  /** Scheduler ticks that ran *during* rendering — see `renderDemoOffline`. */
  ticks: number;
}

/** The shape `analyze` needs — a real `AudioBuffer` satisfies it, and so does
 *  a plain stub, which is what lets the measurement be unit-tested headlessly
 *  (SS15) even though the render itself needs a browser. */
export interface AnalyzableBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface BufferAnalysis {
  peakAbs: number;
  rms: number;
  clippedSamples: number;
  windowRms: number[];
  /**
   * High-frequency energy as a fraction of total energy: the mean square of
   * the first difference `x[i] - x[i-1]` over the mean square of `x`. The
   * first difference is a fixed 6 dB/octave high-pass, so the ratio rises
   * monotonically with how much of the signal sits near Nyquist — for a sine
   * at `f` it is `(2 sin(pi f / fs))^2`.
   *
   * Cheap (one pass, no FFT) and enough to tell a lowpassed render from an
   * open one, which is the only spectral question M0's buffer proof needs to
   * answer. 0 for silence.
   */
  hfRatio: number;
}

/**
 * Level statistics over a rendered buffer: peak, overall RMS, count of
 * over-full-scale samples, and per-`RMS_WINDOW_SECONDS` RMS (the coarse
 * envelope a test uses to prove the clip is spread across time).
 *
 * Exported for its own unit test: these numbers are what the SS15 buffer
 * assertions rest on, so the arithmetic needs pinning independently of the
 * browser-only render that feeds it.
 */
export function analyze(buffer: AnalyzableBuffer): BufferAnalysis {
  let peakAbs = 0;
  let sumSquares = 0;
  let sampleCount = 0;
  let clippedSamples = 0;
  let sumDiffSquares = 0;
  const windowSamples = Math.max(1, Math.round(RMS_WINDOW_SECONDS * buffer.sampleRate));
  const windowCount = Math.ceil(buffer.length / windowSamples);
  const windowSums = new Float64Array(windowCount);
  const windowCounts = new Float64Array(windowCount);

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const sample = data[i]!;
      if (i > 0) {
        const diff = sample - data[i - 1]!;
        sumDiffSquares += diff * diff;
      }
      const abs = Math.abs(sample);
      if (abs > peakAbs) peakAbs = abs;
      if (abs > 1) clippedSamples++;
      const square = sample * sample;
      sumSquares += square;
      sampleCount++;
      const w = (i / windowSamples) | 0;
      windowSums[w]! += square;
      windowCounts[w]! += 1;
    }
  }

  const windowRms: number[] = [];
  for (let w = 0; w < windowCount; w++) {
    const n = windowCounts[w]!;
    windowRms.push(n === 0 ? 0 : Math.sqrt(windowSums[w]! / n));
  }
  return {
    peakAbs,
    rms: sampleCount === 0 ? 0 : Math.sqrt(sumSquares / sampleCount),
    clippedSamples,
    windowRms,
    hfRatio: sumSquares === 0 ? 0 : sumDiffSquares / sumSquares,
  };
}

/**
 * Renders `DEMO_CLIP` through `core.poly-synth -> core.filter` on a fresh
 * `OfflineAudioContext` and returns level stats to assert non-silence against.
 *
 * The transport runs in its NORMAL regime, not a degenerate one: the default
 * 200 ms look-ahead, and a `ManualClock` ticked from `suspend()` callbacks
 * every `DEFAULT_TICK_INTERVAL_MS` of rendered audio, so successive windows
 * post note messages into the worklet's queue while rendering is already
 * under way — the SS12 scheduler-to-worklet handoff the live app depends on.
 * Offline rendering has no wall clock, so `suspend`/`resume` is what stands in
 * for the worker clock; `startRendering()` does the actual (fast) rendering.
 */
export interface RenderDemoOfflineOptions {
  /**
   * Filter cutoff for this render, in Hz, written through the SS4 handle the
   * UI uses (`setLive` + `commit`, fast path A) — no extra write path into the
   * DSP. Rendering the same clip twice with different cutoffs and comparing
   * `hfRatio` is what proves, against real samples, that `core.filter` sits in
   * the audio path with its cutoff bound to the node's own `AudioParam`.
   */
  cutoffHz?: number | undefined;
}

export async function renderDemoOffline(
  options: RenderDemoOfflineOptions = {},
): Promise<OfflineRenderResult> {
  const sampleRate = 44100;
  const durationSeconds = demoClipDurationSeconds();
  const ctx = new OfflineAudioContext(2, Math.ceil(durationSeconds * sampleRate), sampleRate);

  const clock = createManualClock();
  const engine = await createDemoEngine(ctx, ctx.destination, {
    clock,
    lookAheadSeconds: DEFAULT_LOOKAHEAD_SECONDS,
    tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
  });

  const cutoffHz = options.cutoffHz;
  if (cutoffHz !== undefined) {
    const cutoff = engine.params.require(DEMO_CUTOFF_PARAM_ID);
    cutoff.setLive(cutoffHz, "user");
    cutoff.commit();
  }

  // Suspend points must sit on a render-quantum boundary.
  const stepSeconds =
    (Math.max(1, Math.round((DEFAULT_TICK_INTERVAL_MS / 1000) * sampleRate / RENDER_QUANTUM)) *
      RENDER_QUANTUM) /
    sampleRate;
  let ticks = 0;
  for (let at = stepSeconds; at < durationSeconds; at += stepSeconds) {
    const when = at;
    void ctx.suspend(when).then(() => {
      ticks++;
      clock.tick();
      void ctx.resume();
    });
  }

  engine.transport.play(0);

  const buffer = await ctx.startRendering();
  engine.dispose();

  const { peakAbs, rms, clippedSamples, windowRms, hfRatio } = analyze(buffer);
  return {
    sampleRate,
    durationSeconds,
    peakAbs,
    rms,
    clippedSamples,
    windowRms,
    hfRatio,
    ticks,
    ...(cutoffHz === undefined ? {} : { cutoffHz }),
  };
}
