// The visualisers' math, with no canvas and no DOM (SS15: "no browser needed
// for any of the load-bearing logic"). The panel is a thin painter over this.
//
// Two pictures, two jobs:
//
//   SPECTRUM — what is in the sound right now, across frequency. The axis is
//   LOGARITHMIC because hearing is: the octave 40-80 Hz is as musically wide
//   as 5-10 kHz, and a linear FFT axis spends nine tenths of its width on the
//   top two octaves, where almost nothing a mix decision depends on lives.
//
//   LEVEL HISTORY — how loud it has been, over the last few seconds. Peak and
//   RMS together, because they answer different questions: peak is "am I
//   clipping", RMS is "how loud does this feel".

/** Musical spectrum range. Below 20 Hz is not sound; above 20 kHz is not
 *  hearing — and both ends are where an FFT's noise floor lives. */
export const MIN_HZ = 20;
export const MAX_HZ = 20000;

/** Analyser dB window. The Web Audio defaults (-100 .. -30) waste most of the
 *  bar height on the noise floor of a quiet mix; this is the range a mix
 *  actually occupies. */
export const MIN_DB = -90;
export const MAX_DB = -6;

/** Centre frequency of an FFT bin. */
export function binHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

/** 0..1 position of `hz` on the log axis, clamped to the drawn range. */
export function logPosition(hz: number, minHz = MIN_HZ, maxHz = MAX_HZ): number {
  if (hz <= minHz) return 0;
  if (hz >= maxHz) return 1;
  return Math.log(hz / minHz) / Math.log(maxHz / minHz);
}

/** Inverse of `logPosition` — the frequency at a 0..1 position. */
export function hzAtPosition(position: number, minHz = MIN_HZ, maxHz = MAX_HZ): number {
  return minHz * (maxHz / minHz) ** Math.min(1, Math.max(0, position));
}

/**
 * Folds an `AnalyserNode.getByteFrequencyData` buffer into `bandCount`
 * log-spaced bands, each 0..1.
 *
 * MAX within a band, not mean: a single loud partial inside a wide top-octave
 * band is exactly the thing worth seeing, and averaging it against its
 * neighbours is how spectrum displays end up looking like a slope with no
 * features. Bands that fall between bin centres (which happens at the
 * BOTTOM, where bins are wide relative to the log axis) take the nearest
 * bin rather than reading zero, so the low end is continuous instead of
 * combed.
 *
 * Writes into `out` when given — this runs once per animation frame.
 */
export function spectrumBands(
  freqData: Uint8Array,
  sampleRate: number,
  fftSize: number,
  bandCount: number,
  out?: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> {
  const bands = out !== undefined && out.length === bandCount ? out : new Float32Array(bandCount);
  const bins = freqData.length;
  if (bins === 0 || bandCount === 0) return bands;
  const nyquistBin = bins - 1;

  for (let band = 0; band < bandCount; band++) {
    const loHz = hzAtPosition(band / bandCount);
    const hiHz = hzAtPosition((band + 1) / bandCount);
    let loBin = Math.floor((loHz * fftSize) / sampleRate);
    let hiBin = Math.ceil((hiHz * fftSize) / sampleRate);
    if (hiBin <= loBin) hiBin = loBin + 1;
    loBin = Math.min(nyquistBin, Math.max(0, loBin));
    hiBin = Math.min(bins, Math.max(loBin + 1, hiBin));
    let peak = 0;
    for (let bin = loBin; bin < hiBin; bin++) {
      const v = freqData[bin] ?? 0;
      if (v > peak) peak = v;
    }
    bands[band] = peak / 255;
  }
  return bands;
}

/** Peak and RMS of a `getByteTimeDomainData` buffer (128 = silence). */
export function levelOf(timeData: Uint8Array): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  const n = timeData.length;
  if (n === 0) return { peak: 0, rms: 0 };
  for (let i = 0; i < n; i++) {
    const v = ((timeData[i] ?? 128) - 128) / 128;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / n) };
}

/**
 * A fixed-width scrolling history of (peak, rms), oldest to newest.
 *
 * A ring buffer rather than an array that shifts: this is written once per
 * frame forever, and `Array.shift` on a 600-entry array is 600 moves a frame
 * for a picture that scrolls by one pixel.
 */
export class LevelHistory {
  readonly peaks: Float32Array<ArrayBuffer>;
  readonly rms: Float32Array<ArrayBuffer>;
  /** Index the NEXT sample will be written to. */
  #head = 0;
  #filled = 0;

  constructor(readonly capacity: number) {
    this.peaks = new Float32Array(capacity);
    this.rms = new Float32Array(capacity);
  }

  get length(): number {
    return this.#filled;
  }

  push(peak: number, rms: number): void {
    if (this.capacity === 0) return;
    this.peaks[this.#head] = peak;
    this.rms[this.#head] = rms;
    this.#head = (this.#head + 1) % this.capacity;
    if (this.#filled < this.capacity) this.#filled++;
  }

  /** `index` 0 is the OLDEST sample kept, `length - 1` the newest. */
  at(index: number): { peak: number; rms: number } {
    if (index < 0 || index >= this.#filled) return { peak: 0, rms: 0 };
    const start = this.#filled < this.capacity ? 0 : this.#head;
    const i = (start + index) % this.capacity;
    return { peak: this.peaks[i] ?? 0, rms: this.rms[i] ?? 0 };
  }

  clear(): void {
    this.peaks.fill(0);
    this.rms.fill(0);
    this.#head = 0;
    this.#filled = 0;
  }
}

/**
 * Linear amplitude (0..1) -> 0..1 height on the level graph.
 *
 * Amplitude is plotted on a dB scale for the same reason the spectrum's axis
 * is logarithmic: on a linear scale everything below -20 dBFS — which is most
 * of a mix, most of the time — is squashed into the bottom tenth of the
 * graph, and the picture is a flat line with occasional spikes.
 */
export function amplitudeToHeight(amplitude: number, floorDb = -60): number {
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude);
  if (db <= floorDb) return 0;
  return Math.min(1, db / -floorDb + 1);
}
