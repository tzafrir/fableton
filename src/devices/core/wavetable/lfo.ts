// The LFOs. Free-running per voice, seven shapes, and nothing else: an LFO's
// depth and its destination live in the modulation matrix (./matrix.ts), so
// there is no "amount" knob here to disagree with the matrix cell.
//
// Per VOICE, not per device: a slow LFO shared by every voice makes a chord
// breathe in lockstep, which sounds like an effect on the output rather than
// like the notes being alive. Retrigger then means what it says — the shape
// starts at the top of the note — and turning it off lets the voices drift
// apart, which is the whole point of a free-running LFO.

export const LFO_SHAPES = ["Sine", "Triangle", "Saw", "Ramp", "Square", "S&H", "Noise"] as const;
export type LfoShape = (typeof LFO_SHAPES)[number];

const SINE = 0;
const TRIANGLE = 1;
const SAW = 2;
const RAMP = 3;
const SQUARE = 4;
const SAMPLE_HOLD = 5;
const NOISE = 6;

const TAU = Math.PI * 2;

/** A 32-bit LCG: deterministic (so a test can assert a shape) and allocation
 *  free (so it can run on the render thread). */
function nextRandom(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

export class Lfo {
  private phase = 0;
  private rng = 0x9e3779b9;
  /** The value S&H is holding / the value Noise is gliding towards. */
  private target = 0;
  private previous = 0;

  constructor(seed = 0x9e3779b9) {
    this.rng = seed >>> 0;
    this.roll();
    this.previous = this.target;
    this.roll();
  }

  /** Restarts the shape at `phase` (0..1). Retrigger, in one call. */
  reset(phase = 0): void {
    this.phase = phase - Math.floor(phase);
  }

  private roll(): void {
    this.rng = nextRandom(this.rng);
    this.target = (this.rng / 0xffffffff) * 2 - 1;
  }

  /** Advances by `phaseInc` cycles and returns the new value, -1..1. */
  next(shape: number, phaseInc: number): number {
    this.phase += phaseInc;
    if (this.phase >= 1) {
      this.phase -= Math.floor(this.phase);
      // A wrap is where the two random shapes pick their next value.
      this.previous = this.target;
      this.roll();
    } else if (this.phase < 0) {
      this.phase -= Math.floor(this.phase);
    }
    const p = this.phase;
    switch (Math.round(shape)) {
      case SINE:
        return Math.sin(TAU * p);
      case TRIANGLE:
        return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
      case SAW:
        return 1 - 2 * p;
      case RAMP:
        return 2 * p - 1;
      case SQUARE:
        return p < 0.5 ? 1 : -1;
      case SAMPLE_HOLD:
        return this.target;
      case NOISE:
        // The same random values as S&H, but glided across the cycle: a
        // wandering line rather than a staircase.
        return this.previous + (this.target - this.previous) * p;
      default:
        return 0;
    }
  }
}
