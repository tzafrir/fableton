// Radix-2 FFT, and the two things `core.wavetable` actually wants from one:
// ANALYSE a period of a waveform into harmonics, and SYNTHESISE it back at a
// chosen length with everything above a chosen harmonic thrown away.
//
// That pair is the whole band-limiting story for a wavetable oscillator. A
// wavetable is a fixed set of samples read at whatever rate the note needs,
// so a table containing a 400th harmonic is fine on a bottom-octave C and is
// aliasing garbage two octaves up. The fix everybody uses is a MIP PYRAMID:
// the same frame stored several times, each copy holding fewer harmonics, and
// the oscillator picks the copy whose top harmonic still fits under Nyquist
// at the frequency it is playing. Building those copies is exactly
// "resynthesise from the spectrum, stopping at harmonic H" — which is this
// file.
//
// Pure math, no audio objects: it runs at table-build time on the main thread
// (../wavetable/tables.ts) and its output is what gets posted to the worklet.

/** A normalised spectrum: bin k is the complex amplitude of harmonic k. */
export interface Spectrum {
  re: Float64Array;
  im: Float64Array;
}

/**
 * In-place iterative radix-2 FFT. `re`/`im` must be the same power-of-two
 * length. The inverse divides by N, so `inverse(forward(x)) === x`.
 */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fftInPlace: length ${String(n)} is not a power of two`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const br = re[b]!;
        const bi = im[b]!;
        const vr = br * cr - bi * ci;
        const vi = br * ci + bi * cr;
        const ur = re[a]!;
        const ui = im[a]!;
        re[a] = ur + vr;
        im[a] = ui + vi;
        re[b] = ur - vr;
        im[b] = ui - vi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/**
 * One period of a waveform -> its harmonic spectrum, normalised so bin k is
 * independent of the analysis length (a unit-amplitude harmonic k lands at
 * magnitude 0.5, its energy split with the conjugate bin).
 */
export function analyze(period: readonly number[] | Float64Array): Spectrum {
  const n = period.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = period[i]!;
  fftInPlace(re, im, false);
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! / n;
    im[i] = im[i]! / n;
  }
  return { re, im };
}

/**
 * Resynthesise `length` samples from `spec`, keeping harmonics 1..maxHarmonic
 * and dropping DC.
 *
 * Dropping bin 0 is not tidiness: a table with a DC offset thumps every time
 * an envelope opens on it, and several of the shapes in ./tables.ts (a narrow
 * pulse above all) are wildly asymmetric.
 */
export function synthesize(spec: Spectrum, maxHarmonic: number, length: number): Float32Array {
  const re = new Float64Array(length);
  const im = new Float64Array(length);
  const top = Math.min(maxHarmonic, (length >> 1) - 1, (spec.re.length >> 1) - 1);
  for (let k = 1; k <= top; k++) {
    re[k] = spec.re[k]! * length;
    im[k] = spec.im[k]! * length;
    // The conjugate bin is what makes the inverse transform real.
    re[length - k] = spec.re[k]! * length;
    im[length - k] = -spec.im[k]! * length;
  }
  fftInPlace(re, im, true);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = re[i]!;
  return out;
}

/** Peak magnitude of a frame, for the per-table normalisation in ./tables.ts. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
  }
  return peak;
}
