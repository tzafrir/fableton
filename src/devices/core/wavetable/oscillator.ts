// The wavetable oscillator: a phase accumulator plus two interpolations.
//
//   ACROSS THE TABLE — Position picks a point between two frames, and the
//   oscillator reads both and crossfades. That is what makes Position a
//   timbre knob you can sweep (and a modulation destination) rather than a
//   sixteen-way switch.
//
//   ALONG A FRAME — the read point almost never lands on a sample, so the two
//   neighbours are interpolated. Linear is enough here precisely because the
//   frames are already band-limited (../wavetable/fft.ts): the error linear
//   interpolation makes is a gentle top-end roll-off, not the aliasing that
//   the same shortcut would cause on a raw table.
//
// The mip level is chosen once per block, not per sample: it depends on the
// note's frequency, and a level change is a (tiny) timbre step, so moving it
// mid-block would put that step on an arbitrary sample. Per block it lands on
// a 2.7 ms boundary and pitch modulation slides through the levels smoothly.

import { levelForIncrement, type WavetableData } from "./tables";

/** One sample from a frame, linearly interpolated. `phase` is 0..1. */
export function readFrame(frame: Float32Array, phase: number): number {
  const length = frame.length;
  if (length === 0) return 0;
  const x = (phase - Math.floor(phase)) * length;
  const i0 = Math.floor(x);
  const frac = x - i0;
  const a = frame[i0] ?? 0;
  const b = frame[i0 + 1 === length ? 0 : i0 + 1] ?? 0;
  return a + (b - a) * frac;
}

/**
 * One sample of a whole table: Position (0..1) between frames, phase along
 * them. Exported because the editor draws the very waveform the DSP plays —
 * a display fed by its own approximation is a display that lies.
 */
export function sampleFrames(
  frames: readonly Float32Array[],
  frameCount: number,
  position: number,
  phase: number,
): number {
  if (frames.length === 0) return 0;
  const clamped = position < 0 ? 0 : position > 1 ? 1 : position;
  const fp = clamped * (frameCount - 1);
  const f0 = Math.floor(fp);
  const frac = fp - f0;
  const lo = frames[f0] ?? frames[0]!;
  if (frac === 0) return readFrame(lo, phase);
  const hi = frames[Math.min(frameCount - 1, f0 + 1)] ?? lo;
  const a = readFrame(lo, phase);
  return a + (readFrame(hi, phase) - a) * frac;
}

/** The frames of `data` at a level coarse enough to draw from cheaply. */
export function framesForDisplay(data: WavetableData, level = 4): readonly Float32Array[] {
  return data.levels[Math.min(data.levels.length - 1, Math.max(0, level))] ?? [];
}

export class WavetableOscillator {
  private phase = 0;
  private frames: readonly Float32Array[] = [];
  private frameCount = 0;

  /** Starts a note. Phase 0 for every voice makes repeated notes identical,
   *  which is what a synth this deterministic should sound like. */
  reset(phase = 0): void {
    this.phase = phase - Math.floor(phase);
  }

  /** Picks this block's mip level and caches its frames. */
  prepare(data: WavetableData, phaseInc: number): void {
    const level = levelForIncrement(Math.abs(phaseInc));
    this.frames = data.levels[level] ?? [];
    this.frameCount = Math.min(data.frameCount, this.frames.length);
  }

  /** Advances one sample. `position` is 0..1. */
  next(position: number, phaseInc: number): number {
    if (this.frameCount === 0) return 0;
    const out = sampleFrames(this.frames, this.frameCount, position, this.phase);
    this.phase += phaseInc;
    if (this.phase >= 1 || this.phase < 0) this.phase -= Math.floor(this.phase);
    return out;
  }
}
