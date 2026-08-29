// `core.limiter` — a look-ahead brickwall peak limiter: the last thing in a
// master chain, and the one device in the library whose job is a promise
// rather than a sound. Nothing leaves it above the Ceiling.
//
// Written the way SS14's playbook writes an effect and the way
// `core.compressor` writes a worklet one: `p.*` descriptors, a k-rate
// `AudioParam` per param, a gain-reduction READOUT rather than a param, and
// `rampOutAndDisconnect` for a click-free teardown. Everything that makes it
// a limiter rather than a fast compressor is in ./limiter/kernel.ts.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { LOOKAHEAD_MS } from "./limiter/kernel";
import { LIMITER_PROCESSOR_NAME } from "./limiter/processorName";
import limiterWorkletUrl from "../../worklets/limiter-processor.ts?worker&url";

export { LIMITER_PROCESSOR_NAME };

export const Limiter: DeviceDefinition = {
  id: "core.limiter",
  version: 1,
  kind: "audioEffect",
  label: "Limiter",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    // Gain first, because it is the knob you actually turn: a limiter's
    // loudness is how hard you drive it, not where the ceiling sits.
    p.db("gain", "Gain", { min: -12, max: 24, default: 0 }),
    // A hair under full scale by default. Exactly 0.0 dBFS is not a safe
    // ceiling for a file anyone will encode — an mp3 or AAC decoder
    // reconstructs inter-sample peaks above the samples it was given, and a
    // track mastered to 0.0 clips in the player rather than here.
    //
    // NO de-zipper ramp, unlike every other continuous param in the library.
    // The 15 ms default exists so a value change cannot step the signal, and
    // here it would do the opposite: on load the param starts at the
    // worklet's own default and glides to the document's, so a project
    // ceilinged at -6 dB would spend its first fifteen milliseconds honouring
    // something nearer -0.3. That is audible exactly once per render — as an
    // overshoot in the first note of an export. Setting it instantly is safe
    // because the ceiling is not the gain: it changes what the detector ASKS
    // for, and the kernel's look-ahead smoothing still eases the gain itself
    // across the whole window.
    p.db("ceiling", "Ceiling", { min: -24, max: 0, default: -0.3, smoothingMs: 0 }),
    p.ms("release", "Release", { min: 10, max: 1000, default: 150 }),
    // Off by default. Auto-release is the more forgiving setting and it is
    // still not the default, because a Release knob whose value is quietly
    // overridden by a law you cannot see is a knob you stop trusting.
    p.toggle("autoRelease", "Auto", { default: 0 }),
    // Linked keeps the stereo image: one gain for both channels, so a peak on
    // the left does not pull the image toward the right. Unlinked is louder
    // and moves things around, which is occasionally what you want.
    p.toggle("link", "Stereo Link", { default: 1, onLabel: "Linked", offLabel: "L/R" }),
  ],
  // The one number a limiter user watches. A READOUT, not a param (SS7
  // `DeviceReadoutSpec`): the device reports it, nobody can set it, and it
  // never touches the document.
  readouts: [{ id: "reduction", label: "GR", unit: "dB", min: 0, max: 24 }],

  async prepare(ctx): Promise<void> {
    await ctx.audioWorklet.addModule(limiterWorkletUrl);
  },

  create(ctx, io): DeviceInstance {
    const node = new AudioWorkletNode(ctx, LIMITER_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const outGain = ctx.createGain();
    io.in.connect(node, 0, 0);
    node.connect(outGain);
    outGain.connect(io.out);

    // Latest gain reduction, as last reported by the worklet (~every 21 ms).
    // A plain field: `readValue` is called at rAF and must not do work, and a
    // dropped message costs one frame of one meter.
    let reductionDb = 0;
    node.port.onmessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "gr") {
        const value = (data as { value?: unknown }).value;
        if (typeof value === "number" && Number.isFinite(value)) reductionDb = value;
      }
    };

    const param = (name: string): AudioParam => {
      const found = node.parameters.get(name);
      if (found === undefined) throw new Error(`limiter worklet lacks param ${name}`);
      return found;
    };

    return deviceInstance({
      audioParams: {
        gain: param("gain"),
        ceiling: param("ceiling"),
        release: param("release"),
        autoRelease: param("autoRelease"),
        link: param("link"),
      },
      readValue: (readoutId) => (readoutId === "reduction" ? reductionDb : undefined),
      // Look-ahead is delay, and delay is latency. Declared honestly so that
      // when plugin delay compensation lands (SS6 "future PDC") it has a
      // number to work with; until then this is the one device in the library
      // that puts a track three milliseconds behind its neighbours.
      latencySamples: () => Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * ctx.sampleRate)),
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx, also: [node] });
      },
    });
  },
};
