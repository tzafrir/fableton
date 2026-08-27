// AudioWorkletProcessor for `core.gate` (SS6 sidechain, SS7 device).
//
// Two inputs: 0 = main, 1 = sidechain key. All DSP lives in
// ../devices/core/gate/kernel.ts (SS15: testable without a browser); params
// arrive as k-rate AudioParams so the SS4 handles bind them directly.
//
// Keying follows the compressor's rule exactly, and for the same reason — see
// the long note at the head of ./compressor-processor.ts. In short: the `sc`
// PORT node exists whether or not an SS6 edge feeds it, so channel count
// cannot decide keying; the reconciler posts the routing truth, and until it
// does, signal presence is the fallback.
//
// A gate keyed from its own channel's pre-FX tap is the gated-reverb patch:
// the door is opened by the DRY hit while the reverb tail is what passes
// through it.

import { GateKernel } from "../devices/core/gate/kernel";
import { GATE_PROCESSOR_NAME } from "../devices/core/gate/processorName";

export { GATE_PROCESSOR_NAME };

/** |sample| at or below this counts as silence for the presence detector. */
const SC_SILENCE = 1e-7;

/** How long the sidechain may stay silent before keying falls back to the
 *  main input (see ./compressor-processor.ts). */
export const SC_IDLE_SECONDS = 8;

interface ScRoutedMessage {
  type: "scRouted";
  value: boolean;
}

function isScRoutedMessage(data: unknown): data is ScRoutedMessage {
  return (
    typeof data === "object" && data !== null && (data as { type?: unknown }).type === "scRouted"
  );
}

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

export class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: "threshold", automationRate: "k-rate", minValue: -80, maxValue: 0, defaultValue: -30 },
      { name: "attack", automationRate: "k-rate", minValue: 0.05, maxValue: 200, defaultValue: 1 },
      { name: "hold", automationRate: "k-rate", minValue: 0, maxValue: 1000, defaultValue: 40 },
      { name: "release", automationRate: "k-rate", minValue: 1, maxValue: 4000, defaultValue: 180 },
      { name: "floor", automationRate: "k-rate", minValue: -60, maxValue: 0, defaultValue: -60 },
    ];
  }

  readonly kernel = new GateKernel(sampleRate);
  readonly #params = { thresholdDb: -30, attackMs: 1, holdMs: 40, releaseMs: 180, floorDb: -60 };
  #scRouted: boolean | undefined = undefined;
  #scSilentFrames = Number.POSITIVE_INFINITY;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>): void => {
      if (isScRoutedMessage(event.data)) this.#scRouted = event.data.value === true;
    };
  }

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

    for (let ch = 0; ch < out.length; ch++) {
      const src = main[Math.min(ch, main.length - 1)];
      const dst = out[ch];
      if (src !== undefined && dst !== undefined) dst.set(src);
    }

    const p = this.#params;
    p.thresholdDb = parameters["threshold"]?.[0] ?? p.thresholdDb;
    p.attackMs = parameters["attack"]?.[0] ?? p.attackMs;
    p.holdMs = parameters["hold"]?.[0] ?? p.holdMs;
    p.releaseMs = parameters["release"]?.[0] ?? p.releaseMs;
    p.floorDb = parameters["floor"]?.[0] ?? p.floorDb;

    const frames = out[0]?.length ?? 0;
    // The KEY must be the untouched input, never the output: `out` is the
    // signal the gate is closing, so keying off it would latch the gate shut
    // the moment it started to close.
    const key = sc !== undefined && this.#keysFromSidechain(sc, frames) ? sc : main;
    this.kernel.process(out, key, p);
    return true;
  }
}

registerProcessor(GATE_PROCESSOR_NAME, GateProcessor as never);
