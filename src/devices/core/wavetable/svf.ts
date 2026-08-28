// The filter section: a topology-preserving state-variable filter, two of
// them, and the three ways they can be wired.
//
// SVF rather than a biquad because every mode falls out of ONE structure —
// lowpass, bandpass, highpass and notch are four taps off the same two
// integrators, so switching Type costs no state and makes no click. The
// topology-preserving (Zavalishin) form is the one that stays well behaved
// when the cutoff is swept fast, which on this instrument it will be: cutoff
// is a modulation destination, and a naive digital SVF detunes badly as the
// cutoff climbs toward Nyquist.
//
// Coefficients are computed once per BLOCK. `Math.tan` is the expensive part
// and a 2.7 ms grid is finer than any sweep can be heard to step — the same
// trade `core.poly-synth` makes for its one-pole.

/** Type ids, in param-index order. The number is the slope in dB/octave. */
export const FILTER_TYPES = ["LP 12", "LP 24", "HP 12", "HP 24", "BP 12", "Notch"] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

/**
 * How the two filters see the two oscillators.
 *
 *   Serial   — everything through Filter 1, then Filter 2. Two filters in
 *              series is where 24 dB-plus slopes and formant stacks come from.
 *   Parallel — everything through both, summed. A lowpass beside a highpass
 *              is a band-reject you can move each edge of independently.
 *   Split    — Osc A through Filter 1, Osc B through Filter 2. Two half-
 *              instruments in one voice, sharing only the amp envelope.
 */
export const FILTER_ROUTINGS = ["Serial", "Parallel", "Split"] as const;
export type FilterRouting = (typeof FILTER_ROUTINGS)[number];

export const MODE_LP = 0;
export const MODE_BP = 1;
export const MODE_HP = 2;
export const MODE_NOTCH = 3;

/** `[mode, poles]` for each entry of `FILTER_TYPES`. */
const TYPE_TABLE: readonly (readonly [number, number])[] = [
  [MODE_LP, 1],
  [MODE_LP, 2],
  [MODE_HP, 1],
  [MODE_HP, 2],
  [MODE_BP, 1],
  [MODE_NOTCH, 1],
];

export function filterTypeAt(index: number): readonly [number, number] {
  const i = Math.min(TYPE_TABLE.length - 1, Math.max(0, Math.round(index)));
  return TYPE_TABLE[i] ?? TYPE_TABLE[0]!;
}

/**
 * Resonance 0..1 -> the SVF's damping `k` (which is 1/Q).
 *
 * Zero is Butterworth (Q = 0.707, a flat passband — the honest "no
 * resonance"), and the top is Q ≈ 21, loud enough to ring but short of the
 * self-oscillation that would make the filter an oscillator with no note-off.
 * The square makes the useful half of the knob the top half, which is where
 * an ear wants the resolution.
 */
export function resonanceToDamping(res01: number): number {
  const r = res01 < 0 ? 0 : res01 > 1 ? 1 : res01;
  return 1 / (0.707 + r * r * 20);
}

/** dB -> the gain a drive stage multiplies by before its saturator. */
export function driveGain(driveDb: number): number {
  return 10 ** (driveDb / 20);
}

/**
 * The drive stage. EXACTLY transparent at 0 dB — a soft clipper left in the
 * path at unity would still round the peaks, and a param whose readout says
 * "0 dB" must mean the signal is untouched.
 */
export function drive(x: number, gain: number): number {
  if (gain <= 1) return x;
  return Math.tanh(x * gain) / gain ** 0.6;
}

/**
 * The voice output stage: EXACTLY linear below unity, and asymptotic to 2.
 *
 * It exists for one reachable combination — a 24 dB drive into a Q-of-20
 * resonant filter, twice, which is a legal patch and has something like 60 dB
 * of gain in it. Without a stop somewhere, sixteen voices of that is a spike
 * that the mixer meters cannot show and the listener cannot un-hear. Below
 * unity nothing is touched (the derivative is 1 on both sides of the knee),
 * so no ordinary patch meets it at all.
 */
export function softLimit(x: number): number {
  const a = x < 0 ? -x : x;
  if (a <= 1) return x;
  const limited = 2 - 1 / a;
  return x < 0 ? -limited : limited;
}

/** One two-integrator SVF section. Holds state only; the coefficients belong
 *  to the filter that owns it, so a stereo pair computes them once. */
export class SvfState {
  private ic1 = 0;
  private ic2 = 0;

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  step(v0: number, a1: number, a2: number, a3: number, k: number, mode: number): number {
    const v3 = v0 - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    switch (mode) {
      case MODE_LP:
        return v2;
      case MODE_BP:
        return v1 * k;
      case MODE_HP:
        return v0 - k * v1 - v2;
      default:
        return v0 - k * v1;
    }
  }
}

/**
 * One filter slot, in stereo: up to two cascaded sections per channel, all
 * four sharing one set of coefficients.
 *
 * The 24 dB types run both sections at the same damping rather than the
 * textbook "resonance on the first only". Two resonant sections is where the
 * squelch of a 4-pole filter comes from; the flat-passband version sounds
 * like a 12 dB filter with a gentler skirt, which is not what anyone reaches
 * for a 24 dB lowpass to get.
 */
export class StereoFilter {
  private readonly l1 = new SvfState();
  private readonly l2 = new SvfState();
  private readonly r1 = new SvfState();
  private readonly r2 = new SvfState();
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1.414;
  private mode = MODE_LP;
  private poles = 1;
  private driveAmount = 1;

  reset(): void {
    this.l1.reset();
    this.l2.reset();
    this.r1.reset();
    this.r2.reset();
  }

  /** Per block: type, cutoff, resonance and drive in one call. */
  configure(
    typeIndex: number,
    cutoffHz: number,
    resonance01: number,
    driveDb: number,
    sampleRate: number,
  ): void {
    const [mode, poles] = filterTypeAt(typeIndex);
    this.mode = mode;
    this.poles = poles;
    this.driveAmount = driveGain(driveDb);
    const nyquist = sampleRate / 2;
    const clamped = Math.min(nyquist * 0.49, Math.max(10, cutoffHz));
    const g = Math.tan((Math.PI * clamped) / sampleRate);
    const k = resonanceToDamping(resonance01);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  processLeft(x: number): number {
    const driven = drive(x, this.driveAmount);
    const first = this.l1.step(driven, this.a1, this.a2, this.a3, this.k, this.mode);
    return this.poles === 1 ? first : this.l2.step(first, this.a1, this.a2, this.a3, this.k, this.mode);
  }

  processRight(x: number): number {
    const driven = drive(x, this.driveAmount);
    const first = this.r1.step(driven, this.a1, this.a2, this.a3, this.k, this.mode);
    return this.poles === 1 ? first : this.r2.step(first, this.a1, this.a2, this.a3, this.k, this.mode);
  }
}

/**
 * The magnitude the editor draws, from the same numbers the DSP runs on.
 *
 * The frequency axis is warped with the same `tan` the coefficients use, so
 * the curve on screen bends toward Nyquist exactly the way the filter does
 * rather than the way its analogue prototype would.
 */
export function filterMagnitude(
  typeIndex: number,
  cutoffHz: number,
  resonance01: number,
  freqHz: number,
  sampleRate: number,
): number {
  const [mode, poles] = filterTypeAt(typeIndex);
  const nyquist = sampleRate / 2;
  const fc = Math.min(nyquist * 0.49, Math.max(10, cutoffHz));
  const f = Math.min(nyquist * 0.999, Math.max(1, freqHz));
  const x = Math.tan((Math.PI * f) / sampleRate) / Math.tan((Math.PI * fc) / sampleRate);
  const k = resonanceToDamping(resonance01);
  const denom = Math.sqrt((1 - x * x) ** 2 + (k * x) ** 2);
  if (denom < 1e-12) return 1e6;
  let mag: number;
  switch (mode) {
    case MODE_LP:
      mag = 1 / denom;
      break;
    case MODE_HP:
      mag = (x * x) / denom;
      break;
    case MODE_BP:
      mag = (k * x) / denom;
      break;
    default:
      mag = Math.abs(1 - x * x) / denom;
      break;
  }
  return poles === 1 ? mag : mag * mag;
}
