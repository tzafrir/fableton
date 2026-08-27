// `core.saturator` — tanh waveshaping (SS18-M4 "saturator"). Drive is a
// pre-gain in dB; the shaper curve itself is FIXED (a 2048-point tanh), so
// changing drive is a click-free `AudioParam` ramp instead of a curve
// rebuild, with output compensation riding the same handle via a custom
// binding.
//
// GAIN STAGING is the load-bearing part. The curve is plain `tanh(x)` over
// the WaveShaper's ±1 input domain, so its slope at the origin is exactly 1:
// a signal small enough to stay in the linear region comes out at the level it
// went in. (Normalising by `tanh(range)` instead — the obvious way to make the
// curve reach ±1 at its endpoints — multiplies small signals by
// `range / tanh(range)`, which at range 4 is +12 dB of hidden gain: dropping
// the device on a channel at defaults jumped the level ~13 dB and could clip
// the master on the way to the WAV export.)
//
// The post-gain then LEVEL-MATCHES the shaper's own loss at whatever drive is
// set (`saturatorPostGain`), so sweeping Drive changes the harmonics and not
// the loudness — the thing a saturator is actually for.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { dbToGain, deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

export const SHAPER_LENGTH = 2048;

/**
 * Peak amplitude the auto-gain matches — about -6 dBFS, a normally-mixed
 * channel. It is a reference, not a limit: quieter material keeps a little of
 * the drive's push, louder material gives a little back.
 */
export const REFERENCE_AMPLITUDE = 0.5;

/** The transfer function the curve tabulates. WaveShaper clamps its input to
 *  ±1 before the lookup, so anything past the domain saturates at `tanh(1)`. */
export function shapeSample(x: number): number {
  return Math.tanh(Math.max(-1, Math.min(1, x)));
}

/** The fixed transfer curve: `tanh` over the ±1 domain, unity slope at 0. */
export function makeSaturationCurve(length: number = SHAPER_LENGTH): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    curve[i] = shapeSample(x);
  }
  return curve;
}

/**
 * Output gain that keeps a `REFERENCE_AMPLITUDE` peak at the level it entered,
 * for a given drive: the inverse of what the pre-gain plus the curve did to it.
 * Below ~6 dB of drive that is a small make-up for tanh's compression; above
 * it the reference is already pinned to the top of the curve, so the gain
 * settles and further drive squares the wave up instead of turning it up.
 */
export function saturatorPostGain(driveDb: number): number {
  const shaped = shapeSample(REFERENCE_AMPLITUDE * dbToGain(driveDb));
  return REFERENCE_AMPLITUDE / shaped;
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
    // Until the first `drive` push lands, the chain must already be unity —
    // the curve is unity-slope, so this is just its matching post-gain.
    post.gain.value = saturatorPostGain(0);
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
        // Drive raises the pre-gain; the post-gain undoes exactly what the
        // pre-gain and the curve did to a reference-level peak, so the sweep
        // is a timbre control rather than a volume control.
        handle.bindMessage((db, when) => {
          const at = Math.max(0, when);
          pre.gain.setTargetAtTime(dbToGain(db), at, 0.01);
          post.gain.setTargetAtTime(saturatorPostGain(db), at, 0.01);
        });
      },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [dry, wet], { context: ctx, also: [pre, shaper, post] });
      },
    });
  },
};
