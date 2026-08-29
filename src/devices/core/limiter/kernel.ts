// `core.limiter` DSP kernel — plain math, shared verbatim between the
// AudioWorkletProcessor (src/worklets/limiter-processor.ts) and the unit
// tests (SS15: DSP stays testable head-on in Vitest).
//
// A LOOK-AHEAD BRICKWALL PEAK LIMITER, which is a different device from a
// compressor with the ratio wound up — and the difference is the whole file.
//
// A compressor reacts. It sees a peak, then starts pulling the gain down, so
// the front of every transient goes through at whatever level it arrived at.
// Wind the ratio to infinity and that overshoot is exactly what stops the
// ceiling being a ceiling. The only way out is an attack so fast that the
// gain moves inside one cycle of the signal, which is a description of
// distortion.
//
// A limiter ANTICIPATES. The audio is delayed; the detector is not. By the
// time a peak reaches the output, the gain has already been eased down over
// the whole look-ahead window. Nothing is clipped, nothing overshoots, and
// the gain never moves faster than the window allows.
//
// The guarantee is structural, not statistical, and it is worth writing down
// because it is what the tests check. Let D be the look-ahead in samples,
// `desired[n] = min(1, ceiling / |x[n]|)`, and:
//
//   m[n] = min(desired[n-D .. n])        a sliding minimum, window D+1
//   r[n] = m[n] if falling, else it rises toward m[n] at the release rate
//   s[n] = mean(r[n-D+1 .. n])           a moving average, window D
//
// Every r[n-k] in that mean is <= m[n-k], and every one of those minima spans
// an interval containing n-D. So s[n] <= desired[n-D] for every n, and the
// output s[n] * x[n-D] cannot exceed the ceiling. The minimum is what makes
// it early; the mean is what makes it smooth; neither can break the bound.

/** Look-ahead, in milliseconds.
 *
 *  Fixed rather than offered as a knob. The only reason to want it shorter is
 *  latency, and latency is only a problem once something COMPENSATES for it —
 *  `DeviceInstance.latencySamples` exists for that and nothing reads it yet
 *  (SS6 "future PDC"). Until it does, a look-ahead knob would trade audible
 *  smoothness for an inaudible benefit, and changing it mid-stream moves the
 *  delay line under the audio, which is a click. Three milliseconds is the
 *  usual compromise: long enough to ease 20 Hz-ish transients down without
 *  distortion, short enough that the gain still tracks a snare. */
export const LOOKAHEAD_MS = 3;

/** Peak below which a sample counts as silence for the detector. */
const TINY = 1e-9;

export interface LimiterParams {
  /** Drive INTO the ceiling, applied before the detector sees anything. */
  gainDb: number;
  ceilingDb: number;
  releaseMs: number;
  /** Let the release follow the material instead of the knob (see below). */
  autoRelease: boolean;
  /** True: one gain for both channels. False: each channel on its own. */
  link: boolean;
}

export function gainOfDb(db: number): number {
  return 10 ** (db / 20);
}

/** Linear gain -> the reduction a meter shows, in positive dB. */
export function reductionOfGain(gain: number): number {
  return gain >= 1 ? 0 : -20 * Math.log10(Math.max(TINY, gain));
}

/** Per-sample smoothing coefficient for a time constant in ms. */
export function smoothingCoeff(ms: number, sampleRate: number): number {
  if (ms <= 0) return 0;
  return Math.exp(-1 / ((ms / 1000) * sampleRate));
}

/**
 * Minimum over the last `window` values, in O(1) per sample.
 *
 * A monotonic deque: the buffer holds only the values that could still become
 * the minimum, in increasing order, so the front is always the answer.
 * Recomputing the minimum over the window would be 145 comparisons a sample
 * at 48 kHz — per channel, on the render thread.
 */
export class SlidingMinimum {
  private readonly values: Float32Array;
  /** Sample index each value was pushed at. `Float64Array` because an
   *  `Int32` counter overflows after twelve hours of playback. */
  private readonly indices: Float64Array;
  private head = 0;
  private count = 0;
  private cursor = 0;

  constructor(readonly window: number) {
    const capacity = Math.max(1, window) + 1;
    this.values = new Float32Array(capacity);
    this.indices = new Float64Array(capacity);
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.cursor = 0;
  }

  push(value: number): number {
    const capacity = this.values.length;
    // Anything at the back that is >= this value can never be the minimum
    // again: this value is both smaller and younger.
    while (this.count > 0) {
      let back = this.head + this.count - 1;
      if (back >= capacity) back -= capacity;
      if ((this.values[back] ?? 0) >= value) this.count--;
      else break;
    }
    let slot = this.head + this.count;
    if (slot >= capacity) slot -= capacity;
    this.values[slot] = value;
    this.indices[slot] = this.cursor;
    this.count++;
    // Drop anything that has fallen out of the window.
    while (this.count > 0 && (this.indices[this.head] ?? 0) <= this.cursor - this.window) {
      this.head = this.head + 1 >= capacity ? 0 : this.head + 1;
      this.count--;
    }
    this.cursor++;
    return this.values[this.head] ?? value;
  }
}

/** Mean of the last `window` values — the stage that turns the minimum's
 *  steps into ramps. The accumulator is a double so a running sum can be
 *  added to and subtracted from for hours without drifting. */
export class MovingAverage {
  private readonly ring: Float32Array;
  private sum = 0;
  private at = 0;

  constructor(readonly window: number) {
    this.ring = new Float32Array(Math.max(1, window));
    this.ring.fill(1);
    this.sum = this.ring.length;
  }

  reset(): void {
    this.ring.fill(1);
    this.sum = this.ring.length;
    this.at = 0;
  }

  push(value: number): number {
    this.sum -= this.ring[this.at] ?? 0;
    this.ring[this.at] = value;
    this.sum += value;
    this.at = this.at + 1 >= this.ring.length ? 0 : this.at + 1;
    return this.sum / this.ring.length;
  }
}

/** A fixed delay line — the look-ahead itself, on the audio side. */
export class DelayLine {
  private readonly ring: Float32Array;
  private at = 0;

  constructor(readonly length: number) {
    this.ring = new Float32Array(Math.max(1, length));
  }

  reset(): void {
    this.ring.fill(0);
    this.at = 0;
  }

  /** Writes `value` and returns the sample written `length` samples ago. */
  push(value: number): number {
    const out = this.ring[this.at] ?? 0;
    this.ring[this.at] = value;
    this.at = this.at + 1 >= this.ring.length ? 0 : this.at + 1;
    return out;
  }
}

/** One channel's detector chain and delay. */
class LimiterChannel {
  readonly minimum: SlidingMinimum;
  readonly average: MovingAverage;
  readonly delay: DelayLine;
  /** The release smoother's state: the gain it has risen back to. */
  released = 1;
  /** Slow average of the reduction, in dB — what auto-release watches. */
  sustainedDb = 0;

  constructor(lookaheadSamples: number) {
    this.minimum = new SlidingMinimum(lookaheadSamples + 1);
    this.average = new MovingAverage(lookaheadSamples);
    this.delay = new DelayLine(lookaheadSamples);
  }

  reset(): void {
    this.minimum.reset();
    this.average.reset();
    this.delay.reset();
    this.released = 1;
    this.sustainedDb = 0;
  }
}

/**
 * How much sustained gain reduction counts as "this is a loud passage, stop
 * pumping", in dB. Below it the release stays near the fast end and short
 * peaks recover quickly; at or above it the release runs at its slowest.
 */
const AUTO_SUSTAIN_DB = 6;
/** What auto-release may scale the Release knob by, at each end. */
const AUTO_FASTEST = 0.25;
const AUTO_SLOWEST = 4;
/** Time constant of the "is this a passage or a peak" average. */
const AUTO_WATCH_MS = 250;

export class LimiterKernel {
  readonly lookaheadSamples: number;
  private readonly channels: LimiterChannel[];
  /** Last applied reduction in dB (the final sample's). */
  reductionDb = 0;
  /**
   * Largest reduction applied during the LAST `process` call, in dB.
   *
   * The final sample's is the wrong number for a meter — a limiter's whole
   * job is transients that are fully caught and fully released inside one
   * 128-frame block, and an end-of-block reading reports 0 dB for exactly
   * those. Reset per call, so it always describes the block just processed.
   */
  peakReductionDb = 0;

  constructor(
    readonly sampleRate: number,
    lookaheadMs: number = LOOKAHEAD_MS,
  ) {
    this.lookaheadSamples = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
    this.channels = [
      new LimiterChannel(this.lookaheadSamples),
      new LimiterChannel(this.lookaheadSamples),
    ];
  }

  reset(): void {
    for (const channel of this.channels) channel.reset();
    this.reductionDb = 0;
    this.peakReductionDb = 0;
  }

  /**
   * Processes one block IN PLACE. Mono is handled as one channel; anything
   * wider than the two chains uses the last one, which is what a limiter on
   * a stereo bus ever sees.
   *
   * Both chains run whether or not `link` is on, and when it is on they are
   * fed the same detector signal — so they hold identical state and the Link
   * switch can be thrown mid-note without either chain starting from nothing.
   */
  process(io: readonly Float32Array[], params: LimiterParams): void {
    const frames = io[0]?.length ?? 0;
    if (frames === 0) return;
    const channelCount = Math.min(io.length, this.channels.length);
    if (channelCount === 0) return;

    const inputGain = gainOfDb(params.gainDb);
    const ceiling = gainOfDb(params.ceilingDb);
    const release = smoothingCoeff(this.autoReleaseMs(params), this.sampleRate);
    let lowestGain = 1;
    let lastGain = 1;

    for (let i = 0; i < frames; i++) {
      // The detector runs on the GAINED signal: Gain drives the material into
      // the ceiling, which is the only thing it is for.
      let linked = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        const sample = (io[ch]?.[i] ?? 0) * inputGain;
        const peak = sample < 0 ? -sample : sample;
        if (peak > linked) linked = peak;
      }

      for (let ch = 0; ch < channelCount; ch++) {
        const channel = this.channels[ch]!;
        const sample = (io[ch]?.[i] ?? 0) * inputGain;
        const own = sample < 0 ? -sample : sample;
        const peak = params.link ? linked : own;
        const desired = peak <= ceiling ? 1 : ceiling / Math.max(TINY, peak);

        const minimum = channel.minimum.push(desired);
        // Down instantly (the minimum is already D samples early), up at the
        // release rate. Either way the result stays at or below the minimum,
        // which is what the averaging stage below relies on.
        channel.released =
          minimum < channel.released
            ? minimum
            : minimum - (minimum - channel.released) * release;
        const gain = channel.average.push(channel.released);

        io[ch]![i] = channel.delay.push(sample) * gain;
        if (gain < lowestGain) lowestGain = gain;
        if (ch === 0) lastGain = gain;
      }
    }

    this.reductionDb = reductionOfGain(lastGain);
    this.peakReductionDb = reductionOfGain(lowestGain);
    this.watchSustain(params, frames);
  }

  /** The release actually used this block: the knob, or the knob shaped by
   *  how long the limiter has been working (see `AUTO_SUSTAIN_DB`). */
  private autoReleaseMs(params: LimiterParams): number {
    if (!params.autoRelease) return params.releaseMs;
    let sustained = 0;
    for (const channel of this.channels) {
      if (channel.sustainedDb > sustained) sustained = channel.sustainedDb;
    }
    const factor = Math.min(1, sustained / AUTO_SUSTAIN_DB);
    return params.releaseMs * (AUTO_FASTEST + (AUTO_SLOWEST - AUTO_FASTEST) * factor);
  }

  /** Feeds this block's reduction into the slow average auto-release reads.
   *  Once per block, not per sample: it is answering "is this a passage or a
   *  peak", and a 128-sample grid is far finer than that question. */
  private watchSustain(params: LimiterParams, frames: number): void {
    if (!params.autoRelease) {
      for (const channel of this.channels) channel.sustainedDb = 0;
      return;
    }
    const blockSeconds = frames / this.sampleRate;
    const coeff = Math.exp(-blockSeconds / (AUTO_WATCH_MS / 1000));
    for (const channel of this.channels) {
      const target = reductionOfGain(channel.released);
      channel.sustainedDb = target + (channel.sustainedDb - target) * coeff;
    }
  }
}
