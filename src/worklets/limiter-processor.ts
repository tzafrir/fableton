// AudioWorkletProcessor for `core.limiter`.
//
// One input, one output, and no decisions: all the DSP lives in
// ../devices/core/limiter/kernel.ts (SS15: testable without a browser) and
// every param arrives as a k-rate `AudioParam`, so the SS4 handles bind them
// directly with no message plumbing.
//
// The one thing this file adds over "call the kernel" is the gain-reduction
// report, throttled the way the compressor's is — see `GR_REPORT_QUANTA`.

import { LimiterKernel, type LimiterParams } from "../devices/core/limiter/kernel";
import { LIMITER_PROCESSOR_NAME } from "../devices/core/limiter/processorName";

export { LIMITER_PROCESSOR_NAME };

/**
 * How often the processor reports gain reduction to the main thread, in
 * render quanta. 8 quanta is ~21 ms at 48 kHz — under a rAF frame, so the
 * meter never starves, and two orders of magnitude cheaper than a message per
 * block. The value reported is the PEAK over the interval: a limiter's meter
 * exists to show the transients, and an instantaneous sample would miss them.
 */
export const GR_REPORT_QUANTA = 8;

/** Message the processor posts back with that peak. */
export interface GrMessage {
  type: "gr";
  /** Peak gain reduction over the interval, in dB (positive = quieter). */
  value: number;
}

export class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: "gain", automationRate: "k-rate", minValue: -12, maxValue: 24, defaultValue: 0 },
      { name: "ceiling", automationRate: "k-rate", minValue: -24, maxValue: 0, defaultValue: -0.3 },
      { name: "release", automationRate: "k-rate", minValue: 10, maxValue: 1000, defaultValue: 150 },
      { name: "autoRelease", automationRate: "k-rate", minValue: 0, maxValue: 1, defaultValue: 0 },
      { name: "link", automationRate: "k-rate", minValue: 0, maxValue: 1, defaultValue: 1 },
    ];
  }

  readonly kernel = new LimiterKernel(sampleRate);
  // Reused across blocks (SS12: zero allocation in the render path).
  readonly #params: LimiterParams = {
    gainDb: 0,
    ceilingDb: -0.3,
    releaseMs: 150,
    autoRelease: false,
    link: true,
  };
  #grPeakDb = 0;
  #grQuanta = 0;

  override process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0];
    const out = outputs[0];
    if (out === undefined) return true;

    // Copy input -> output, then limit the OUTPUT in place. An input with no
    // channels is a disconnected port, not silence to pass through: the
    // limiter still has to run, because its delay line is holding up to three
    // milliseconds of audio that has not come out yet.
    for (let ch = 0; ch < out.length; ch++) {
      const src = input?.[Math.min(ch, (input.length || 1) - 1)];
      const dst = out[ch];
      if (dst === undefined) continue;
      if (src === undefined) dst.fill(0);
      else dst.set(src);
    }

    const p = this.#params;
    p.gainDb = parameters["gain"]?.[0] ?? p.gainDb;
    p.ceilingDb = parameters["ceiling"]?.[0] ?? p.ceilingDb;
    p.releaseMs = parameters["release"]?.[0] ?? p.releaseMs;
    p.autoRelease = (parameters["autoRelease"]?.[0] ?? 0) >= 0.5;
    p.link = (parameters["link"]?.[0] ?? 1) >= 0.5;

    this.kernel.process(out, p);

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

registerProcessor(LIMITER_PROCESSOR_NAME, LimiterProcessor as never);
