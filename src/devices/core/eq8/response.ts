// The magnitude response of one EQ band, as a pure function.
//
// WHY THIS EXISTS AT ALL, given `BiquadFilterNode.getFrequencyResponse`
// already answers the question: the curve has to be drawn from the DOCUMENT,
// not from the graph. The panel repaints before audio is booted, for a
// channel whose devices are not mounted, and during an offline render there
// is no live node to ask. A pure function of (type, freq, gain, Q) draws in
// all three cases, is unit-testable without a browser, and cannot drift out
// of step with the knob the user is turning.
//
// The formulas are the Web Audio API's own — which are the RBJ Audio EQ
// Cookbook's — with one deliberate difference at the boundary. The spec
// reads `BiquadFilterNode.Q` as DECIBELS for `lowpass`/`highpass`
// (`alpha = sin(w0) / (2 * 10^(Q/20))`) and as a plain quality factor for
// everything else. Handing a user a knob that changes meaning depending on
// the band's type is indefensible, so `Q` means a QUALITY FACTOR throughout
// this app and the DEVICE converts (`20 * log10(q)`) on the way into the
// node. The conversion cancels out here, which is why every non-shelf type
// below uses the same `sin(w0) / (2Q)`.
//
// Shelves ignore `Q` entirely and use `S = 1`, which is what Web Audio fixes
// them at.
//
// e2e/mixer/eq8.spec.ts checks this against a real browser's
// `getFrequencyResponse`, so "the same formulas" is a measured claim.

/** The filter types an EQ8 band can be, in the order the picker lists them. */
export const BAND_TYPES = [
  "lowcut",
  "lowshelf",
  "bell",
  "notch",
  "highshelf",
  "highcut",
] as const;
export type BandType = (typeof BAND_TYPES)[number];

/** Labels, for `p.enum` (SS4: an enum's value IS the index). */
export const BAND_TYPE_LABELS = [
  "Low Cut",
  "Low Shelf",
  "Bell",
  "Notch",
  "High Shelf",
  "High Cut",
];

/** The `BiquadFilterType` each band type is built from. */
export const BIQUAD_TYPE: Readonly<Record<BandType, BiquadFilterType>> = {
  lowcut: "highpass",
  lowshelf: "lowshelf",
  bell: "peaking",
  notch: "notch",
  highshelf: "highshelf",
  highcut: "lowpass",
};

/** Band types whose `gain` does anything. The rest ignore it (Web Audio
 *  ignores `gain` on every type but the three below), so the editor greys the
 *  control out rather than letting the user drag a number with no effect. */
export const GAIN_TYPES: ReadonlySet<BandType> = new Set<BandType>(["lowshelf", "bell", "highshelf"]);

/** Band types whose `Q` a `BiquadFilterNode` reads in DECIBELS rather than as
 *  a quality factor. The device converts on the way in; see the header. */
export const Q_DB_TYPES: ReadonlySet<BandType> = new Set<BandType>(["lowcut", "highcut"]);

/** Band types whose `Q` does anything. Shelves are fixed at `S = 1`. */
export const Q_TYPES: ReadonlySet<BandType> = new Set<BandType>([
  "lowcut",
  "bell",
  "notch",
  "highcut",
]);

export function bandTypeFromIndex(index: number): BandType {
  const i = Math.min(BAND_TYPES.length - 1, Math.max(0, Math.round(index)));
  return BAND_TYPES[i] ?? "bell";
}

/** One band, as the response math needs it. */
export interface BandSettings {
  readonly type: BandType;
  readonly freqHz: number;
  readonly gainDb: number;
  readonly q: number;
  /** A disabled band is EXACTLY transparent, not merely quiet — see the
   *  device: it becomes a peaking filter at 0 dB, whose numerator and
   *  denominator are identical. */
  readonly enabled: boolean;
}

/** Normalized biquad coefficients (a0 divided out is not required — the
 *  magnitude is a ratio — so they are returned raw). */
interface Coefficients {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

const UNITY: Coefficients = { b0: 1, b1: 0, b2: 0, a0: 1, a1: 0, a2: 0 };

/** Web Audio clamps a filter's frequency to the Nyquist rate and its Q to a
 *  finite range; matching that keeps the drawn curve honest at the edges. */
function coefficientsFor(band: BandSettings, sampleRate: number): Coefficients {
  if (!band.enabled) return UNITY;
  const nyquist = sampleRate / 2;
  const f0 = Math.min(nyquist - 1, Math.max(1, band.freqHz));
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const q = Math.max(1e-4, band.q);
  const A = 10 ** (band.gainDb / 40);

  switch (band.type) {
    case "lowcut": {
      // `q` is a quality factor here; see the header for the conversion the
      // device applies on the way into the node.
      const alpha = sin / (2 * q);
      return {
        b0: (1 + cos) / 2,
        b1: -(1 + cos),
        b2: (1 + cos) / 2,
        a0: 1 + alpha,
        a1: -2 * cos,
        a2: 1 - alpha,
      };
    }
    case "highcut": {
      const alpha = sin / (2 * q);
      return {
        b0: (1 - cos) / 2,
        b1: 1 - cos,
        b2: (1 - cos) / 2,
        a0: 1 + alpha,
        a1: -2 * cos,
        a2: 1 - alpha,
      };
    }
    case "notch": {
      const alpha = sin / (2 * q);
      return { b0: 1, b1: -2 * cos, b2: 1, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha };
    }
    case "bell": {
      const alpha = sin / (2 * q);
      return {
        b0: 1 + alpha * A,
        b1: -2 * cos,
        b2: 1 - alpha * A,
        a0: 1 + alpha / A,
        a1: -2 * cos,
        a2: 1 - alpha / A,
      };
    }
    case "lowshelf": {
      // S = 1, which is what Web Audio fixes shelves at.
      const alpha = (sin / 2) * Math.SQRT2;
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * (A + 1 - (A - 1) * cos + twoSqrtAAlpha),
        b1: 2 * A * (A - 1 - (A + 1) * cos),
        b2: A * (A + 1 - (A - 1) * cos - twoSqrtAAlpha),
        a0: A + 1 + (A - 1) * cos + twoSqrtAAlpha,
        a1: -2 * (A - 1 + (A + 1) * cos),
        a2: A + 1 + (A - 1) * cos - twoSqrtAAlpha,
      };
    }
    case "highshelf": {
      const alpha = (sin / 2) * Math.SQRT2;
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * (A + 1 + (A - 1) * cos + twoSqrtAAlpha),
        b1: -2 * A * (A - 1 + (A + 1) * cos),
        b2: A * (A + 1 + (A - 1) * cos - twoSqrtAAlpha),
        a0: A + 1 - (A - 1) * cos + twoSqrtAAlpha,
        a1: 2 * (A - 1 - (A + 1) * cos),
        a2: A + 1 - (A - 1) * cos - twoSqrtAAlpha,
      };
    }
  }
}

/** |H(e^jw)| in dB for one band at `freqHz`. 0 for a disabled band. */
export function bandResponseDb(band: BandSettings, freqHz: number, sampleRate: number): number {
  const c = coefficientsFor(band, sampleRate);
  const w = (2 * Math.PI * Math.min(freqHz, sampleRate / 2)) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  // z^-1 = cos(w) - j sin(w).
  const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const numIm = -(c.b1 * sin1 + c.b2 * sin2);
  const denRe = c.a0 + c.a1 * cos1 + c.a2 * cos2;
  const denIm = -(c.a1 * sin1 + c.a2 * sin2);
  const den = denRe * denRe + denIm * denIm;
  if (den === 0) return 0;
  const magnitude = Math.sqrt((numRe * numRe + numIm * numIm) / den);
  // A true zero (a notch exactly on its centre) is -inf dB; the floor keeps
  // the drawn curve finite and off the bottom of the canvas.
  if (magnitude <= 1e-6) return -120;
  return 20 * Math.log10(magnitude);
}

/** The whole EQ's response: the bands are in series, so their dB add. */
export function totalResponseDb(
  bands: readonly BandSettings[],
  freqHz: number,
  sampleRate: number,
): number {
  let total = 0;
  for (const band of bands) total += bandResponseDb(band, freqHz, sampleRate);
  return total;
}
