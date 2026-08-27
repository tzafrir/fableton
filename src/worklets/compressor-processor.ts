// AudioWorkletProcessor for `core.compressor` (SS18-M4, SS6 sidechain).
//
// Two inputs: 0 = main, 1 = sidechain key. When the sc input carries any
// connected channels this block, IT is the detector; otherwise the main
// input keys itself — which is exactly the "Audio From: None" behaviour.
// All DSP lives in ../devices/core/compressor/kernel.ts (SS15: testable
// without a browser); params arrive as k-rate AudioParams so the SS4
// handles bind them directly.

import { CompressorKernel } from "../devices/core/compressor/kernel";
import { COMPRESSOR_PROCESSOR_NAME } from "../devices/core/compressor/processorName";

export { COMPRESSOR_PROCESSOR_NAME };

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

    const key = sc !== undefined && sc.length > 0 ? sc : out;
    this.kernel.process(out, key, p);
    return true;
  }
}

registerProcessor(COMPRESSOR_PROCESSOR_NAME, CompressorProcessor as never);
