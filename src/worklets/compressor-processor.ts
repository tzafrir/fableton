// AudioWorkletProcessor for `core.compressor` (SS18-M4, SS6 sidechain).
//
// Two inputs: 0 = main, 1 = sidechain key. All DSP lives in
// ../devices/core/compressor/kernel.ts (SS15: testable without a browser);
// params arrive as k-rate AudioParams so the SS4 handles bind them directly.
//
// WHICH INPUT KEYS THE DETECTOR is deliberately NOT decided by
// `inputs[1].length`. `Compressor.create` connects the harness-owned `sc` PORT
// NODE to input 1 the moment the device is mounted — SS7 gives every declared
// port a node that exists whether or not the SS6 edge feeds it — so input 1
// always carries channels, and a channel-count test would key EVERY un-routed
// compressor off permanent silence: threshold/ratio would then do nothing at
// all, which is a compressor that never compresses.
//
// So keying is decided from ROUTING, in two layers:
//
//   1. Authoritative: `{ type: 'scRouted', value: boolean }` posted to the
//      node's port when the SS6 edge is attached or detached. `Compressor`
//      posts it from `DeviceInstance.portRouted`, which the graph reconciler
//      calls after every apply (the edge is document data, so the reconciler
//      is the only code that can know).
//   2. Until that message arrives: the port node is silent unless an edge
//      feeds it, so the key is used only while it actually CARRIES signal, and
//      for `SC_IDLE_SECONDS` after its last non-zero sample. An un-routed
//      compressor therefore self-keys (correct), and a live sidechain keys off
//      its source across the gaps between hits (orders of magnitude shorter
//      than the timeout) and keeps keying through them. The residue this
//      heuristic cannot see is a routed-but-long-silent key, which falls back
//      to self-keying until the key sounds again; layer 1 removes it for good.

import { CompressorKernel } from "../devices/core/compressor/kernel";
import { COMPRESSOR_PROCESSOR_NAME } from "../devices/core/compressor/processorName";

export { COMPRESSOR_PROCESSOR_NAME };

/** |sample| at or below this counts as silence for the presence detector. */
const SC_SILENCE = 1e-7;

/**
 * How long the sidechain input may stay silent before keying falls back to the
 * main input. Comfortably longer than any gap between hits of a musical key
 * source (a half-time kick at 60 bpm is 2 s), short enough that clearing
 * "Audio From" restores ordinary compression within a few seconds.
 */
export const SC_IDLE_SECONDS = 8;

/**
 * How often the processor reports gain reduction to the main thread, in
 * render quanta. 8 quanta is ~21 ms at 48 kHz — under a rAF frame, so the
 * meter never starves, and two orders of magnitude cheaper than a message
 * per block. The value reported is the PEAK reduction over the interval, not
 * the last sample's: a GR meter that sampled instantaneously would miss the
 * very transients a compressor exists to catch.
 */
export const GR_REPORT_QUANTA = 8;

/** Message the processor posts back with that peak. */
export interface GrMessage {
  type: "gr";
  /** Peak gain reduction over the interval, in dB (positive = quieter). */
  value: number;
}

/** Message the main thread may post to state the SS6 routing truth outright. */
interface ScRoutedMessage {
  type: "scRouted";
  value: boolean;
}

function isScRoutedMessage(data: unknown): data is ScRoutedMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "scRouted"
  );
}

/** True when any channel of `input` carries a sample above the noise floor. */
function carriesSignal(input: readonly Float32Array[]): boolean {
  for (let ch = 0; ch < input.length; ch++) {
    const data = input[ch];
    if (data === undefined) continue;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i] ?? 0) > SC_SILENCE) return true;
    }
  }
  return false;
}

export class CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: "threshold", automationRate: "k-rate", minValue: -60, maxValue: 0, defaultValue: -24 },
      { name: "ratio", automationRate: "k-rate", minValue: 1, maxValue: 20, defaultValue: 4 },
      { name: "attack", automationRate: "k-rate", minValue: 0.1, maxValue: 250, defaultValue: 5 },
      { name: "release", automationRate: "k-rate", minValue: 5, maxValue: 2000, defaultValue: 120 },
      { name: "makeup", automationRate: "k-rate", minValue: 0, maxValue: 24, defaultValue: 0 },
    ];
  }

  readonly kernel = new CompressorKernel(sampleRate);
  // Reused across blocks (SS12: zero allocation in the render path).
  readonly #params = { thresholdDb: -24, ratio: 4, attackMs: 5, releaseMs: 120, makeupDb: 0 };
  /** Routing truth from the main thread; `undefined` until it says (layer 1). */
  #scRouted: boolean | undefined = undefined;
  /** Frames since the sc input last carried signal (layer 2). */
  #scSilentFrames = Number.POSITIVE_INFINITY;
  /** Peak reduction seen since the last report, and the quanta counter. */
  #grPeakDb = 0;
  #grQuanta = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>): void => {
      if (isScRoutedMessage(event.data)) this.#scRouted = event.data.value === true;
    };
  }

  /** Layer 1 if the main thread has spoken, else layer 2 (see the header). */
  #keysFromSidechain(sc: Float32Array[], frames: number): boolean {
    if (sc.length === 0) return false;
    if (this.#scRouted !== undefined) return this.#scRouted;
    if (carriesSignal(sc)) this.#scSilentFrames = 0;
    else this.#scSilentFrames += frames;
    return this.#scSilentFrames < SC_IDLE_SECONDS * sampleRate;
  }

  override process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const main = inputs[0];
    const sc = inputs[1];
    const out = outputs[0];
    if (main === undefined || out === undefined || main.length === 0) return true;

    // Copy input -> output, then compress the OUTPUT in place.
    for (let ch = 0; ch < out.length; ch++) {
      const src = main[Math.min(ch, main.length - 1)];
      const dst = out[ch];
      if (src !== undefined && dst !== undefined) dst.set(src);
    }

    const p = this.#params;
    p.thresholdDb = parameters["threshold"]?.[0] ?? p.thresholdDb;
    p.ratio = parameters["ratio"]?.[0] ?? p.ratio;
    p.attackMs = parameters["attack"]?.[0] ?? p.attackMs;
    p.releaseMs = parameters["release"]?.[0] ?? p.releaseMs;
    p.makeupDb = parameters["makeup"]?.[0] ?? p.makeupDb;

    const frames = out[0]?.length ?? 0;
    const key = sc !== undefined && this.#keysFromSidechain(sc, frames) ? sc : out;
    this.kernel.process(out, key, p);

    // SS5 readout: gain reduction, peak-held between reports. The kernel
    // already tracks it per sample for exactly this; all that is added here
    // is the throttle, so the render path costs one compare and one counter.
    if (this.kernel.peakReductionDb > this.#grPeakDb) this.#grPeakDb = this.kernel.peakReductionDb;
    if (++this.#grQuanta >= GR_REPORT_QUANTA) {
      this.#grQuanta = 0;
      const message: GrMessage = { type: "gr", value: this.#grPeakDb };
      this.port.postMessage(message);
      this.#grPeakDb = 0;
    }
    return true;
  }
}

registerProcessor(COMPRESSOR_PROCESSOR_NAME, CompressorProcessor as never);
