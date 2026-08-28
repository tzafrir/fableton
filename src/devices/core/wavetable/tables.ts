// The wavetables themselves, and the mip pyramid each one is built into.
//
// A "wavetable" here is FRAME_COUNT single-cycle waveforms stacked in order;
// the oscillator's Position param reads between them, so sweeping Position is
// a continuous timbre change rather than a switch. Every table is written as
// a FUNCTION of (position, x) rather than as sample data, for three reasons:
// a few hundred lines of formulas ship instead of a few megabytes of audio,
// the same code draws the display and feeds the DSP so they cannot disagree,
// and a table can be described in the terms that make it musical ("two
// formants sliding apart") instead of as an opaque blob.
//
// A spec gives EITHER a time-domain shape (`frame`) or the amplitude of each
// harmonic (`harmonic`). Both end up in the same place: a spectrum, which is
// resynthesised once per mip level with everything above that level's top
// harmonic dropped (see ./fft.ts for why the pyramid exists at all).
//
// Harmonic specs are built in SINE phase — amplitude 1/k in sine phase is
// exactly a sawtooth, all the classical series come out right, and aligning
// every harmonic in cosine phase instead would pile them into one spike and
// leave normalisation to throw the level away.

import { analyze, peakOf, synthesize, type Spectrum } from "./fft";

/** Frames per table. Sixteen is enough for a smooth Position sweep and small
 *  enough that a whole table's pyramid is a quarter-megabyte. */
export const FRAME_COUNT = 16;

/**
 * Copies of each frame, each with half the harmonics of the one before.
 *
 * Ten, not eight: the pyramid has to reach all the way down to ONE harmonic,
 * or the top of the keyboard runs out of levels. A 7 kHz note can carry two
 * harmonics under Nyquist and no more, and a narrowest level of four would
 * alias there — on the one note where an alias is a bare tone rather than
 * something buried in a spectrum.
 */
export const MIP_LEVELS = 10;

const BASE_LENGTH = 2048;
const BASE_MAX_HARMONIC = 512;
/** Shortest table kept; below this the read cost is all wrap-around anyway. */
const MIN_LENGTH = 16;
const MIN_MAX_HARMONIC = 1;

/** Samples in one frame at `level`. */
export function mipLength(level: number): number {
  return Math.max(MIN_LENGTH, BASE_LENGTH >> level);
}

/** Highest harmonic present at `level`. */
export function mipMaxHarmonic(level: number): number {
  return Math.max(MIN_MAX_HARMONIC, BASE_MAX_HARMONIC >> level);
}

/**
 * Which level a note running at `phaseInc` cycles per sample may read.
 *
 * Nyquist allows `0.5 / phaseInc` harmonics; the level chosen is the first
 * whose top harmonic fits under that. Level 0 tops out at 512 harmonics, so a
 * bottom-octave note is a hair short of the full spectrum — 512 harmonics of
 * a 30 Hz fundamental already reach 15 kHz, and the notes that would miss
 * anything audible are the ones nobody plays a bright wavetable on.
 */
export function levelForIncrement(phaseInc: number): number {
  const allowed = phaseInc > 0 ? 0.5 / phaseInc : Number.POSITIVE_INFINITY;
  for (let level = 0; level < MIP_LEVELS; level++) {
    if (mipMaxHarmonic(level) <= allowed) return level;
  }
  return MIP_LEVELS - 1;
}

export interface WavetableSpec {
  id: string;
  label: string;
  /** One line for the editor: what sweeping Position actually does here. */
  blurb: string;
  /** Time-domain shape at morph position `t` (0..1) and phase `x` (0..1). */
  frame?: (t: number, x: number) => number;
  /** ...or the amplitude of harmonic `k` (1-based) at morph position `t`. */
  harmonic?: (t: number, k: number) => number;
}

const TAU = Math.PI * 2;

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** The four textbook shapes, by index — the endpoints "Basics" morphs through. */
function basicShape(index: number, x: number): number {
  switch (index) {
    case 0:
      return Math.sin(TAU * x);
    case 1:
      return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    case 2:
      return x < 0.5 ? 1 : -1;
    default:
      return 1 - 2 * x;
  }
}

/** Deterministic 0..1 hash — the "random" in Bits, without a seeded RNG whose
 *  state would have to be threaded through a pure per-harmonic function. */
function hash(k: number, seed: number): number {
  const x = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function gaussian(k: number, centre: number, width: number): number {
  const d = (k - centre) / width;
  return Math.exp(-d * d);
}

export const WAVETABLES: readonly WavetableSpec[] = [
  {
    id: "basics",
    label: "Basics",
    blurb: "sine → triangle → square → saw",
    frame: (t, x) => {
      const s = t * 3;
      const i = Math.min(2, Math.floor(s));
      return lerp(basicShape(i, x), basicShape(i + 1, x), s - i);
    },
  },
  {
    id: "pulse",
    label: "Pulse",
    blurb: "duty cycle 50% → 4%: PWM without an LFO on the width",
    frame: (t, x) => (x < 0.5 - t * 0.46 ? 1 : -1),
  },
  {
    id: "fold",
    label: "Fold",
    blurb: "a sine driven into a wavefolder, harder as you climb",
    frame: (t, x) => Math.sin((Math.PI / 2) * (1 + t * 4.5) * Math.sin(TAU * x)),
  },
  {
    id: "formant",
    label: "Formant",
    blurb: "one resonant peak walking up the harmonic series",
    harmonic: (t, k) => gaussian(k, 1 + t * 22, 2.2 + t * 3) / Math.sqrt(k),
  },
  {
    id: "vox",
    label: "Vox",
    blurb: "two formants sliding apart — oo → ah → ee",
    harmonic: (t, k) =>
      (gaussian(k, 3 + t * 3, 2) + 0.6 * gaussian(k, 7 + t * 17, 3) + 0.25 / k) / Math.sqrt(k),
  },
  {
    id: "comb",
    label: "Comb",
    blurb: "a comb whose notches spread — square at the bottom, hollow at the top",
    harmonic: (t, k) => Math.abs(Math.sin((Math.PI * k) / (2 + t * 14))) / k,
  },
  {
    id: "organ",
    label: "Organ",
    blurb: "drawbars: octaves, then a third, pulled out one at a time",
    harmonic: (t, k) => {
      if (k === 1) return 1;
      const octave = (k & (k - 1)) === 0;
      const third = k === 3 || k === 6 || k === 12;
      if (!octave && !third) return 0;
      const rank = Math.log2(k);
      const open = Math.max(0, Math.min(1, t * 5 - (rank - 1) * 0.9));
      return ((third ? 0.5 : 1) * open) / Math.sqrt(k);
    },
  },
  {
    id: "bits",
    label: "Bits",
    blurb: "three random spectra, crossfaded — digital, and never quite the same twice",
    harmonic: (t, k) => {
      const seg = t * 3;
      const i = Math.min(2, Math.floor(seg));
      const amp = lerp(hash(k, i), hash(k, i + 1), seg - i);
      return (0.2 + 0.8 * amp) / k ** 1.1;
    },
  },
];

export const WAVETABLE_LABELS: readonly string[] = WAVETABLES.map((w) => w.label);

/** One table, built: `levels[level][frame]` is a frame's samples at that mip. */
export interface WavetableData {
  readonly index: number;
  readonly frameCount: number;
  readonly levels: readonly (readonly Float32Array[])[];
}

/** Clamps an index onto the catalogue — enum params arrive as floats. */
export function wavetableAt(index: number): WavetableSpec {
  const i = Math.min(WAVETABLES.length - 1, Math.max(0, Math.round(index)));
  return WAVETABLES[i] ?? WAVETABLES[0]!;
}

function spectrumOf(spec: WavetableSpec, t: number): Spectrum {
  if (spec.harmonic !== undefined) {
    const re = new Float64Array(BASE_LENGTH);
    const im = new Float64Array(BASE_LENGTH);
    for (let k = 1; k <= BASE_MAX_HARMONIC; k++) {
      // Sine phase: `im[k] = -A/2`, mirrored into the conjugate bin by
      // `synthesize`. (`analyze` normalises a unit harmonic to 0.5 for the
      // same reason — its energy is split across the two bins.)
      im[k] = -(spec.harmonic(t, k) ?? 0) / 2;
    }
    return { re, im };
  }
  const shape = spec.frame ?? ((_t: number, x: number) => Math.sin(TAU * x));
  const period = new Float64Array(BASE_LENGTH);
  for (let i = 0; i < BASE_LENGTH; i++) period[i] = shape(t, i / BASE_LENGTH);
  return analyze(period);
}

const cache = new Map<number, WavetableData>();

/**
 * Builds (and remembers) the whole pyramid for one table.
 *
 * Every mip level of a frame is scaled by the SAME normalisation factor —
 * the one that puts the widest level at unity. Normalising each level on its
 * own would make a note change loudness as it crossed a mip boundary, which
 * is a glide artefact nobody can find afterwards.
 */
export function buildWavetable(index: number): WavetableData {
  const i = Math.min(WAVETABLES.length - 1, Math.max(0, Math.round(index)));
  const cached = cache.get(i);
  if (cached !== undefined) return cached;

  const spec = WAVETABLES[i]!;
  const levels: Float32Array[][] = Array.from({ length: MIP_LEVELS }, () => []);
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const t = frame / (FRAME_COUNT - 1);
    const spectrum = spectrumOf(spec, t);
    const widest = synthesize(spectrum, mipMaxHarmonic(0), mipLength(0));
    const peak = peakOf(widest);
    const scale = peak > 1e-6 ? 1 / peak : 1;
    for (let level = 0; level < MIP_LEVELS; level++) {
      const samples =
        level === 0 ? widest : synthesize(spectrum, mipMaxHarmonic(level), mipLength(level));
      for (let n = 0; n < samples.length; n++) samples[n] = samples[n]! * scale;
      levels[level]![frame] = samples;
    }
  }
  const data: WavetableData = { index: i, frameCount: FRAME_COUNT, levels };
  cache.set(i, data);
  return data;
}
