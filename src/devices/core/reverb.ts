// `core.reverb` — convolution reverb (SS18-M4) over a PROCEDURAL impulse:
// exponentially decaying noise, stereo-decorrelated, generated from a SEEDED
// PRNG so an offline export renders byte-identically run to run (SS12/SS2).
//
// `size` regenerates the impulse via a message binding — a rebuild, not a
// ramp, so it applies at the next render quantum; mid-playback size sweeps
// are not a thing convolution can do click-free and the descriptor says so
// in its label. `mix` is the usual equal-power pair.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

/** Deterministic xorshift32 — the seed keeps renders reproducible. */
export function makeNoise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** Stereo impulse: `seconds` long, 60 dB down by the end. */
export function makeImpulse(
  ctx: BaseAudioContext,
  seconds: number,
  seed = 0x5eed,
): AudioBuffer {
  const length = Math.max(64, Math.round(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rand = makeNoise(seed + ch * 7919);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // -60 dB exponential decay.
      data[i] = (rand() * 2 - 1) * Math.pow(10, -3 * t);
    }
  }
  return buffer;
}

export const Reverb: DeviceDefinition = {
  id: "core.reverb",
  version: 1,
  kind: "audioEffect",
  label: "Reverb",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    p.continuous("size", "Size (rebuilds)", { min: 0.1, max: 8, default: 1.8, unit: "s", taper: "log" }),
    p.pct("mix", "Mix", { default: 30 }),
  ],

  create(ctx, io): DeviceInstance {
    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    const wet = ctx.createGain();
    const dry = ctx.createGain();

    io.in.connect(dry);
    dry.connect(io.out);
    io.in.connect(convolver);
    convolver.connect(wet);
    wet.connect(io.out);

    let currentSize = Number.NaN;

    return deviceInstance({
      gainParams: { mix: [wet, dry] },
      connectParam: (localId, handle) => {
        if (localId !== "size") return;
        handle.bindMessage((seconds) => {
          // Regenerate only on a real change — `load()` re-pushes values.
          if (seconds === currentSize) return;
          currentSize = seconds;
          convolver.buffer = makeImpulse(ctx, seconds);
        });
      },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [dry, wet], { context: ctx, also: [convolver] });
      },
    });
  },
};
