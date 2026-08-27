// `core.saturator` — tanh waveshaping (SS18-M4 "saturator"). Drive is a
// pre-gain in dB; the shaper curve itself is FIXED (a 2048-point tanh), so
// changing drive is a click-free `AudioParam` ramp instead of a curve
// rebuild, with output compensation riding the same handle via a custom
// binding.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { dbToGain, deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

export const SHAPER_LENGTH = 2048;

/** The fixed transfer curve: tanh over ±4 input range, normalized. */
export function makeSaturationCurve(length: number = SHAPER_LENGTH): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  const range = 4;
  const norm = Math.tanh(range);
  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * range) / norm;
  }
  return curve;
}

export const Saturator: DeviceDefinition = {
  id: "core.saturator",
  version: 1,
  kind: "audioEffect",
  label: "Saturator",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    p.db("drive", "Drive", { min: 0, max: 36, default: 6 }),
    p.pct("mix", "Mix", { default: 100 }),
  ],

  create(ctx, io): DeviceInstance {
    const pre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSaturationCurve();
    shaper.oversample = "4x";
    const post = ctx.createGain();
    const wet = ctx.createGain();
    const dry = ctx.createGain();

    io.in.connect(dry);
    dry.connect(io.out);
    io.in.connect(pre);
    pre.connect(shaper);
    shaper.connect(post);
    post.connect(wet);
    wet.connect(io.out);

    return deviceInstance({
      gainParams: { mix: [wet, dry] },
      connectParam: (localId, handle) => {
        if (localId !== "drive") return;
        // Drive raises the pre-gain and pulls the post-gain part-way back
        // (half-dB compensation keeps loudness usable across the sweep).
        handle.bindMessage((db, when) => {
          const at = Math.max(0, when);
          pre.gain.setTargetAtTime(dbToGain(db), at, 0.01);
          post.gain.setTargetAtTime(dbToGain(-db / 2), at, 0.01);
        });
      },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [dry, wet], { context: ctx, also: [pre, shaper, post] });
      },
    });
  },
};
