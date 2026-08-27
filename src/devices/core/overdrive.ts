// `core.overdrive` and `core.distortion` — the two ends of clipping.
//
// Both are WaveShapers, and both hold the same gain-staging line the
// saturator draws (see saturator.ts): the curve has unity slope at the
// origin, and a post-gain undoes what the pre-gain plus the curve did to a
// reference-level peak. Dropping either on a channel at defaults must not
// change the level — only the harmonics.
//
// What separates them is the SHAPE, and it is worth being precise about why
// there are two devices rather than one with a knob:
//
//   Overdrive  — cubic soft clip. The transfer curve's slope falls off
//                smoothly, so harmonics come in gradually and mostly low
//                order. Pushed hard it compresses; it never develops a
//                corner. This is the "amp pushed a bit" sound.
//   Distortion — hard clip with an adjustable knee (`edge`). At edge 0 it is
//                the same soft curve; at edge 100 it is a true hard clip
//                with a discontinuous slope, which is where the high-order
//                harmonics (and the buzz) live.
//
// Both carry a `tone` lowpass after the shaper, because clipping generates
// harmonics well past where they are wanted; a distortion without a tone
// control is unusable in a mix.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { dbToGain, deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

export const SHAPER_LENGTH = 2048;

/** Peak the auto-gain matches — about -6 dBFS, a normally-mixed channel. */
export const REFERENCE_AMPLITUDE = 0.5;

/**
 * Cubic soft clip, unity slope at 0, flat at ±1.
 *
 *   f(x) = x - x^3/3, scaled so f(1) = 1
 *
 * The scaling is what keeps the slope at the origin exactly 1 (the plain
 * polynomial would give 1 too, but the ×1.5 normalisation needed to reach
 * full scale at ±1 would put +3.5 dB of hidden gain into every small signal
 * — the same trap saturator.ts documents).
 */
export function softClip(x: number): number {
  const c = Math.max(-1, Math.min(1, x));
  return c - (c * c * c) / 3;
}

/**
 * Soft clip blended toward a hard clip. `edge` 0..1 crossfades the CURVE, not
 * the audio: at 1 the transfer function has a corner at ±(1 - something
 * small), which is exactly the discontinuity that generates the high-order
 * harmonics a distortion is for.
 */
export function hardClip(x: number, edge: number): number {
  const e = Math.max(0, Math.min(1, edge));
  const soft = softClip(x);
  // The hard leg clips at the same peak the soft leg reaches, so the
  // crossfade changes shape without changing output level.
  const ceiling = softClip(1);
  const hard = Math.max(-ceiling, Math.min(ceiling, x));
  return soft * (1 - e) + hard * e;
}

export function makeCurve(
  shape: (x: number) => number,
  length: number = SHAPER_LENGTH,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    curve[i] = shape((i / (length - 1)) * 2 - 1);
  }
  return curve;
}

/** Output gain keeping a `REFERENCE_AMPLITUDE` peak at the level it entered. */
export function postGainFor(shape: (x: number) => number, driveDb: number): number {
  const shaped = shape(REFERENCE_AMPLITUDE * dbToGain(driveDb));
  // A curve can flatten to (near) zero slope; never divide the world by it.
  return shaped === 0 ? 1 : REFERENCE_AMPLITUDE / shaped;
}

/** The shared body: pre-gain -> shaper -> tone -> post-gain, wet/dry mixed. */
function createClipper(
  ctx: BaseAudioContext,
  io: { in: AudioNode; out: AudioNode },
  options: {
    shapeFor: (edge: number) => (x: number) => number;
    /** Rebuilding the curve is only needed by the device that has an edge. */
    hasEdge: boolean;
  },
): DeviceInstance {
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const tone = ctx.createBiquadFilter();
  const post = ctx.createGain();
  const wet = ctx.createGain();
  const dry = ctx.createGain();

  let edge = 0;
  let driveDb = 0;
  let shape = options.shapeFor(edge);
  shaper.curve = makeCurve(shape);
  shaper.oversample = "4x";
  tone.type = "lowpass";
  tone.Q.value = 0.7;
  tone.frequency.value = 8000;
  post.gain.value = postGainFor(shape, 0);

  io.in.connect(dry);
  dry.connect(io.out);
  io.in.connect(pre);
  pre.connect(shaper);
  shaper.connect(tone);
  tone.connect(post);
  post.connect(wet);
  wet.connect(io.out);

  /** The curve is only rebuilt when `edge` moves — a drive sweep is a plain
   *  AudioParam ramp, so it stays click-free (saturator.ts's rule). */
  const rebuild = (when: number): void => {
    shape = options.shapeFor(edge);
    shaper.curve = makeCurve(shape);
    post.gain.setTargetAtTime(postGainFor(shape, driveDb), Math.max(0, when), 0.01);
  };

  return deviceInstance({
    gainParams: { mix: [wet, dry] },
    audioParams: { tone: tone.frequency },
    connectParam: (localId, handle) => {
      if (localId === "drive") {
        handle.bindMessage((db, when) => {
          driveDb = db;
          const at = Math.max(0, when);
          pre.gain.setTargetAtTime(dbToGain(db), at, 0.01);
          post.gain.setTargetAtTime(postGainFor(shape, db), at, 0.01);
        });
        return;
      }
      if (options.hasEdge && localId === "edge") {
        handle.bindMessage((pct, when) => {
          edge = pct / 100;
          rebuild(when);
        });
      }
    },
    dispose: (when?: Seconds): void => {
      rampOutAndDisconnect(when, [dry, wet], { context: ctx, also: [pre, shaper, tone, post] });
    },
  });
}

export const Overdrive: DeviceDefinition = {
  id: "core.overdrive",
  version: 1,
  kind: "audioEffect",
  label: "Overdrive",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    p.db("drive", "Drive", { min: 0, max: 36, default: 8 }),
    p.hz("tone", "Tone", { min: 400, max: 18000, default: 8000 }),
    p.pct("mix", "Mix", { default: 100 }),
  ],
  create(ctx, io): DeviceInstance {
    return createClipper(ctx, io, { shapeFor: () => softClip, hasEdge: false });
  },
};

export const Distortion: DeviceDefinition = {
  id: "core.distortion",
  version: 1,
  kind: "audioEffect",
  label: "Distortion",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    p.db("drive", "Drive", { min: 0, max: 48, default: 18 }),
    // At 0 this IS the overdrive's curve; the device earns its name past ~50.
    p.pct("edge", "Edge", { default: 70 }),
    p.hz("tone", "Tone", { min: 400, max: 18000, default: 5000 }),
    p.pct("mix", "Mix", { default: 100 }),
  ],
  create(ctx, io): DeviceInstance {
    return createClipper(ctx, io, {
      shapeFor: (edge) => (x) => hardClip(x, edge),
      hasEdge: true,
    });
  },
};
