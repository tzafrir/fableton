// The parts of `core.wavetable` that are just math — which is nearly all of
// it (SS15: "no browser needed for any of the load-bearing logic").
//
// The claims worth a test here are the ones an ear cannot settle quickly and
// a picture cannot settle at all: that the mip pyramid really is band-limited
// (the difference between a wavetable synth and a chorus of aliases), that
// the curve the editor draws is the response the filter actually has, and
// that a matrix cell means what its label says it means.

import { describe, expect, it } from "vitest";
import { analyze, fftInPlace, peakOf, synthesize } from "./fft";
import { Lfo, LFO_SHAPES } from "./lfo";
import {
  MOD_PARAM_IDS,
  MOD_SOURCES,
  MOD_TARGETS,
  SOURCE_COUNT,
  SOURCE_LFO1,
  SOURCE_VEL,
  TARGET_COUNT,
  TARGET_CUT1,
  TARGET_PITCH,
  applyMatrix,
  cellIndex,
  keyTrackValue,
  modParamId,
} from "./matrix";
import { WavetableOscillator, readFrame, sampleFrames } from "./oscillator";
import { AUDIO_PARAM_IDS, WAVETABLE_PARAMS, workletParameterDescriptors } from "./params";
import { FILTER_TYPES, StereoFilter, drive, filterMagnitude, resonanceToDamping } from "./svf";
import {
  FRAME_COUNT,
  MIP_LEVELS,
  WAVETABLES,
  buildWavetable,
  levelForIncrement,
  mipLength,
  mipMaxHarmonic,
} from "./tables";
import { VoicePool } from "./voicePool";

const SR = 48000;

/** Peak amplitude of a block, the measurement most of these tests reduce to. */
function peak(samples: readonly number[] | Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > max) max = v;
  }
  return max;
}

/** RMS of the second half of a block — past whatever transient started it. */
function settledRms(samples: number[]): number {
  const from = samples.length >> 1;
  let sum = 0;
  for (let i = from; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (samples.length - from));
}

describe("the FFT, and the band-limiting it exists for", () => {
  it("round-trips: inverse(forward(x)) is x", () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i) * 0.5 + Math.cos(i * 0.31);
    const original = Float64Array.from(re);
    fftInPlace(re, im, false);
    fftInPlace(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]!).toBeCloseTo(original[i]!, 10);
  });

  it("rejects a length that is not a power of two rather than returning noise", () => {
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6), false)).toThrow(/power of two/);
  });

  it("a single harmonic resynthesises as that sine, at the amplitude asked for", () => {
    const spec = { re: new Float64Array(256), im: new Float64Array(256) };
    spec.im[3] = -0.5 / 2; // amplitude 0.5, sine phase
    const out = synthesize(spec, 16, 256);
    for (let i = 0; i < 256; i++) {
      expect(out[i]!).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 3 * i) / 256), 6);
    }
  });

  it("throws away everything above the harmonic it is given", () => {
    const period = new Float64Array(512);
    for (let i = 0; i < 512; i++) period[i] = i < 256 ? 1 : -1; // a square: all odd harmonics
    const limited = synthesize(analyze(period), 5, 512);
    const back = analyze(Float64Array.from(limited));
    for (let k = 6; k < 60; k++) {
      expect(Math.hypot(back.re[k]!, back.im[k]!)).toBeLessThan(1e-6);
    }
    // ...and kept the ones below it: harmonics 1, 3 and 5 of a square.
    expect(Math.hypot(back.re[1]!, back.im[1]!)).toBeGreaterThan(0.5);
    expect(Math.hypot(back.re[3]!, back.im[3]!)).toBeGreaterThan(0.15);
  });

  it("drops DC, so an asymmetric shape comes back centred", () => {
    const period = new Float64Array(256);
    for (let i = 0; i < 256; i++) period[i] = i < 32 ? 1 : -1; // heavily offset
    const out = synthesize(analyze(period), 64, 256);
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += out[i]!;
    expect(Math.abs(sum / 256)).toBeLessThan(1e-6);
  });
});

describe("the wavetable catalogue", () => {
  it("ships eight tables, each with a label and a line about what Position does", () => {
    expect(WAVETABLES).toHaveLength(8);
    const ids = WAVETABLES.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const table of WAVETABLES) {
      expect(table.label.length).toBeGreaterThan(0);
      expect(table.blurb.length).toBeGreaterThan(0);
      // Exactly one of the two ways to describe a frame.
      expect((table.frame === undefined) !== (table.harmonic === undefined)).toBe(true);
    }
  });

  it("builds every table as a full pyramid, every frame normalised and audible", () => {
    for (let index = 0; index < WAVETABLES.length; index++) {
      const data = buildWavetable(index);
      expect(data.frameCount).toBe(FRAME_COUNT);
      expect(data.levels).toHaveLength(MIP_LEVELS);
      for (let level = 0; level < MIP_LEVELS; level++) {
        const frames = data.levels[level]!;
        expect(frames).toHaveLength(FRAME_COUNT);
        for (const frame of frames) expect(frame.length).toBe(mipLength(level));
      }
      // Level 0 is the one normalisation was measured on, so it peaks at 1;
      // every other level is the same frame with harmonics removed, so it can
      // only be quieter — but never silent, or Position would have a dead spot.
      for (const frame of data.levels[0]!) expect(peakOf(frame)).toBeCloseTo(1, 5);
      for (const frame of data.levels[3]!) {
        expect(peakOf(frame)).toBeGreaterThan(0.1);
        expect(peakOf(frame)).toBeLessThanOrEqual(1.05);
      }
    }
  });

  it("caches: asking twice gives the same arrays back, not a second build", () => {
    expect(buildWavetable(2)).toBe(buildWavetable(2));
  });

  it("Basics starts as a sine and ends as a saw", () => {
    const frames = buildWavetable(0).levels[0]!;
    const first = frames[0]!;
    for (let i = 0; i < 64; i++) {
      const phase = i / 64;
      expect(readFrame(first, phase)).toBeCloseTo(Math.sin(2 * Math.PI * phase), 3);
    }
    // A saw is a falling ramp — but a BAND-LIMITED one, so it is a ramp
    // wearing Gibbs ripple and "monotonically decreasing" is false at every
    // wrinkle. What is true, and is the actual claim, is that the shape IS
    // that ramp: correlate it against one.
    const last = frames[FRAME_COUNT - 1]!;
    let dot = 0;
    let normFrame = 0;
    let normRamp = 0;
    for (let i = 0; i < 1000; i++) {
      const ramp = 1 - (2 * i) / 1000;
      const value = readFrame(last, i / 1000);
      dot += ramp * value;
      normFrame += value * value;
      normRamp += ramp * ramp;
    }
    expect(dot / Math.sqrt(normFrame * normRamp)).toBeGreaterThan(0.98);
  });

  it("picks a mip level whose top harmonic still fits under Nyquist", () => {
    for (const hz of [27.5, 55, 110, 440, 1760, 7040, 12000]) {
      const inc = hz / SR;
      const level = levelForIncrement(inc);
      const topHarmonicHz = mipMaxHarmonic(level) * hz;
      // The one exception is the bottom of the range, where level 0 is
      // already the widest table there is.
      if (level > 0) expect(topHarmonicHz).toBeLessThanOrEqual(SR / 2);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThan(MIP_LEVELS);
    }
    expect(levelForIncrement(27.5 / SR)).toBe(0);
    expect(levelForIncrement(7040 / SR)).toBeGreaterThan(3);
    // Even the top of the keyboard finds a level that fits.
    expect(mipMaxHarmonic(levelForIncrement(12000 / SR)) * 12000).toBeLessThanOrEqual(SR / 2);
  });
});

describe("the oscillator", () => {
  const data = buildWavetable(0);

  it("Position 0 and 1 read the end frames exactly, and between them it crossfades", () => {
    const frames = data.levels[2]!;
    const phase = 0.31;
    expect(sampleFrames(frames, FRAME_COUNT, 0, phase)).toBeCloseTo(readFrame(frames[0]!, phase), 9);
    expect(sampleFrames(frames, FRAME_COUNT, 1, phase)).toBeCloseTo(
      readFrame(frames[FRAME_COUNT - 1]!, phase),
      9,
    );
    // Half way between frames 0 and 1 is the mean of the two.
    const half = 0.5 / (FRAME_COUNT - 1);
    expect(sampleFrames(frames, FRAME_COUNT, half, phase)).toBeCloseTo(
      (readFrame(frames[0]!, phase) + readFrame(frames[1]!, phase)) / 2,
      6,
    );
  });

  it("plays at the frequency it is asked for", () => {
    const osc = new WavetableOscillator();
    const hz = 440;
    const inc = hz / SR;
    osc.prepare(data, inc);
    osc.reset();
    let crossings = 0;
    let previous = 0;
    const seconds = 0.5;
    for (let i = 0; i < SR * seconds; i++) {
      const s = osc.next(0, inc); // Position 0 == a pure sine
      if (previous <= 0 && s > 0) crossings++;
      previous = s;
    }
    expect(crossings).toBeGreaterThanOrEqual(hz * seconds - 1);
    expect(crossings).toBeLessThanOrEqual(hz * seconds + 1);
  });

  it("does not alias: the brightest table, played high, has no energy above Nyquist's mirror", () => {
    // A saw at 5 kHz would put harmonics at 10, 15, 20, 25 kHz — and the
    // fourth of those folds back to 23 kHz on the way down. If the mip
    // pyramid is doing its job, nothing above harmonic 4 is in the table at
    // all, so nothing can fold.
    const osc = new WavetableOscillator();
    // Exactly on an analysis bin (213 * 48000 / 2048), so the measurement is
    // reading the signal rather than its own spectral leakage.
    const hz = (213 * SR) / 2048;
    const inc = hz / SR;
    osc.prepare(data, inc);
    osc.reset();
    const n = 2048;
    const block = new Float64Array(n);
    for (let i = 0; i < n; i++) block[i] = osc.next(1, inc);
    const spectrum = analyze(block);
    const binOf = (freq: number): number => Math.round((freq * n) / SR);
    let fundamental = 0;
    let above = 0;
    for (let k = 1; k < n / 2; k++) {
      const mag = Math.hypot(spectrum.re[k]!, spectrum.im[k]!);
      const freq = (k * SR) / n;
      if (Math.abs(k - binOf(hz)) <= 2) fundamental = Math.max(fundamental, mag);
      // Anything BELOW the fundamental is either an alias or nothing.
      else if (freq < hz - 200) above = Math.max(above, mag);
    }
    expect(fundamental).toBeGreaterThan(0.1);
    expect(above).toBeLessThan(fundamental / 100);
  });
});

describe("the filter section", () => {
  /**
   * Amplitude a filter settles to for a sine at `hz`.
   *
   * RMS x sqrt(2), not the peak sample: 8 kHz at a 48 kHz rate is six samples
   * a cycle, and the largest of six samples of a unit sine is 0.87 — a peak
   * reading would score a perfectly flat filter at -1.2 dB and blame the
   * filter for it.
   */
  function measure(typeIndex: number, cutoff: number, res: number, hz: number): number {
    const filter = new StereoFilter();
    filter.configure(typeIndex, cutoff, res, 0, SR);
    const total = Math.ceil(SR * 0.6);
    const from = Math.floor(total * 0.7);
    let sum = 0;
    for (let i = 0; i < total; i++) {
      const y = filter.processLeft(Math.sin((2 * Math.PI * hz * i) / SR));
      if (i >= from) sum += y * y;
    }
    return Math.sqrt(sum / (total - from)) * Math.SQRT2;
  }

  it("a lowpass passes what is below it and stops what is above", () => {
    expect(measure(0, 1000, 0, 100)).toBeCloseTo(1, 1);
    expect(measure(0, 1000, 0, 8000)).toBeLessThan(0.05);
  });

  it("a highpass is the mirror image", () => {
    expect(measure(2, 1000, 0, 8000)).toBeCloseTo(1, 1);
    expect(measure(2, 1000, 0, 100)).toBeLessThan(0.05);
  });

  it("24 dB is twice as steep as 12 dB — an octave above the cutoff, squared", () => {
    const twelve = measure(0, 1000, 0, 4000);
    const twentyFour = measure(1, 1000, 0, 4000);
    expect(twentyFour).toBeLessThan(twelve * 0.2);
    expect(twentyFour).toBeCloseTo(twelve * twelve, 2);
  });

  it("resonance lifts the cutoff and leaves the passband alone", () => {
    // At zero resonance the cutoff is -3 dB, by definition of a cutoff.
    expect(measure(0, 1000, 0, 1000)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(measure(0, 1000, 1, 1000)).toBeGreaterThan(8);
    expect(measure(0, 1000, 1, 100)).toBeCloseTo(1, 1);
  });

  it("the curve the editor draws is the response the filter has", () => {
    // The one test that keeps a picture honest: same numbers, both paths.
    for (const typeIndex of [0, 1, 2, 4, 5]) {
      for (const hz of [120, 500, 1000, 3000, 9000]) {
        const measured = measure(typeIndex, 1000, 0.4, hz);
        const drawn = filterMagnitude(typeIndex, 1000, 0.4, hz, SR);
        // A notch's null is a divide by zero on both sides of the comparison;
        // what it has to agree about there is simply "nothing comes out".
        if (drawn < 0.01) {
          expect(measured).toBeLessThan(0.05);
          continue;
        }
        expect(Math.abs(20 * Math.log10(measured / drawn))).toBeLessThan(1.0);
      }
    }
  });

  it("declares one type per entry in FILTER_TYPES, and resonance runs 0.7 to 20 in Q", () => {
    expect(FILTER_TYPES).toHaveLength(6);
    expect(1 / resonanceToDamping(0)).toBeCloseTo(0.707, 3);
    expect(1 / resonanceToDamping(1)).toBeGreaterThan(20);
  });

  it("drive is EXACTLY transparent at unity, and saturates above it", () => {
    for (const x of [-0.9, -0.2, 0, 0.35, 1]) expect(drive(x, 1)).toBe(x);
    expect(drive(1, 4)).toBeLessThan(1);
    expect(drive(0.02, 4)).toBeGreaterThan(0.02); // small signals get louder
  });

  it("is stereo: the two channels filter independently", () => {
    const filter = new StereoFilter();
    filter.configure(0, 500, 0, 0, SR);
    for (let i = 0; i < 400; i++) {
      filter.processLeft(1);
      filter.processRight(0);
    }
    expect(filter.processLeft(1)).toBeGreaterThan(0.9);
    expect(Math.abs(filter.processRight(0))).toBeLessThan(0.01);
  });
});

describe("the LFOs", () => {
  const run = (shape: number, steps: number, inc = 1 / steps): number[] => {
    const lfo = new Lfo(12345);
    lfo.reset();
    return Array.from({ length: steps }, () => lfo.next(shape, inc));
  };

  it("every shape stays inside -1..1", () => {
    for (let shape = 0; shape < LFO_SHAPES.length; shape++) {
      expect(peak(run(shape, 200))).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("sine and triangle rise from zero, square is only ever ±1", () => {
    expect(run(0, 100)[0]!).toBeGreaterThan(0);
    expect(run(0, 100)[24]!).toBeCloseTo(1, 1);
    for (const v of run(4, 40)) expect(Math.abs(v)).toBe(1);
  });

  it("sample & hold holds inside the cycle and moves at the wrap", () => {
    const lfo = new Lfo(7);
    lfo.reset();
    const a = lfo.next(5, 0.25);
    expect(lfo.next(5, 0.25)).toBe(a);
    expect(lfo.next(5, 0.25)).toBe(a);
    lfo.next(5, 0.25); // wraps
    expect(lfo.next(5, 0.25)).not.toBe(a);
  });

  it("two LFOs seeded differently do not pick the same random values", () => {
    const one = new Lfo(1);
    const two = new Lfo(2);
    one.reset();
    two.reset();
    const a = Array.from({ length: 8 }, () => one.next(5, 0.5));
    const b = Array.from({ length: 8 }, () => two.next(5, 0.5));
    expect(a).not.toEqual(b);
  });

  it("retrigger restarts the shape", () => {
    const lfo = new Lfo(3);
    lfo.reset();
    for (let i = 0; i < 7; i++) lfo.next(0, 0.1);
    lfo.reset();
    expect(lfo.next(0, 0.1)).toBeCloseTo(Math.sin(2 * Math.PI * 0.1), 6);
  });
});

describe("the modulation matrix", () => {
  it("is six sources by seven destinations, each cell a stable param id", () => {
    expect(MOD_SOURCES).toHaveLength(6);
    expect(MOD_TARGETS).toHaveLength(7);
    expect(modParamId(SOURCE_LFO1, TARGET_CUT1)).toBe("modLfo1Cut1");
    expect(modParamId(SOURCE_VEL, TARGET_PITCH)).toBe("modVelPitch");
    const flat = MOD_PARAM_IDS.flat();
    expect(flat).toHaveLength(SOURCE_COUNT * TARGET_COUNT);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("sums each destination in ITS OWN units", () => {
    const amounts = new Float32Array(SOURCE_COUNT * TARGET_COUNT);
    const sources = new Float32Array(SOURCE_COUNT);
    const out = new Float32Array(TARGET_COUNT);

    amounts[cellIndex(SOURCE_LFO1, TARGET_PITCH)] = 0.5; // 50%
    sources[SOURCE_LFO1] = 1;
    applyMatrix(amounts, sources, out);
    // Pitch's full swing is two octaves, so half of it at full LFO is 12 st.
    expect(out[TARGET_PITCH]).toBeCloseTo(12, 6);
    expect(out[TARGET_CUT1]).toBe(0);

    // Two sources on one destination add.
    amounts[cellIndex(SOURCE_VEL, TARGET_PITCH)] = -0.25;
    sources[SOURCE_VEL] = 1;
    applyMatrix(amounts, sources, out);
    expect(out[TARGET_PITCH]).toBeCloseTo(12 - 6, 6);
  });

  it("an untouched matrix modulates nothing", () => {
    const out = new Float32Array(TARGET_COUNT).fill(9);
    const sources = new Float32Array(SOURCE_COUNT).fill(1);
    applyMatrix(new Float32Array(SOURCE_COUNT * TARGET_COUNT), sources, out);
    for (const v of out) expect(v).toBe(0);
  });

  it("keytracking is centred on C3 and clamps three octaves out", () => {
    expect(keyTrackValue(60)).toBe(0);
    expect(keyTrackValue(72)).toBeCloseTo(1 / 3, 6);
    expect(keyTrackValue(127)).toBe(1);
    expect(keyTrackValue(0)).toBe(-1);
  });
});

describe("the voice pool", () => {
  it("hands out slots below the limit only, and steals the oldest when they are full", () => {
    const pool = new VoicePool(16);
    pool.setLimit(3);
    const used = [pool.allocate(60), pool.allocate(62), pool.allocate(64)];
    for (const slot of used) expect(slot).toBeLessThan(3);
    expect(new Set(used).size).toBe(3);
    expect(pool.allocate(65)).toBe(used[0]); // the oldest goes
  });

  it("pairs each note-off with one note-on, oldest first", () => {
    const pool = new VoicePool(8);
    const first = pool.allocate(60);
    const second = pool.allocate(60);
    expect(pool.release(60)).toBe(first);
    expect(pool.release(60)).toBe(second);
    expect(pool.release(60)).toBeNull();
  });

  it("lowering the limit leaves the voices above it ringing rather than cutting them", () => {
    const pool = new VoicePool(8);
    pool.setLimit(8);
    const high = pool.allocate(60);
    for (let i = 0; i < 6; i++) pool.allocate(61 + i);
    pool.setLimit(2);
    // The slot above the new limit still knows its pitch, so its note-off
    // will still find it.
    if (high >= 2) expect(pool.pitchOf(high)).toBe(60);
    expect(pool.allocate(70)).toBeLessThan(2);
  });

  it("clamps a limit outside the pool", () => {
    const pool = new VoicePool(4);
    pool.setLimit(99);
    expect(pool.limit).toBe(4);
    pool.setLimit(0);
    expect(pool.limit).toBe(1);
  });
});

describe("the param declaration", () => {
  it("declares ninety params, all uniquely named", () => {
    const ids = WAVETABLE_PARAMS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(90);
  });

  it("keeps the two table params off the AudioParam path — they carry samples", () => {
    expect(AUDIO_PARAM_IDS).not.toContain("aTable");
    expect(AUDIO_PARAM_IDS).not.toContain("bTable");
    expect(AUDIO_PARAM_IDS).toHaveLength(88);
  });

  it("derives the worklet's descriptors from the same list, ranges and all", () => {
    const descriptors = workletParameterDescriptors();
    expect(descriptors).toHaveLength(AUDIO_PARAM_IDS.length);
    for (const d of descriptors) {
      const source = WAVETABLE_PARAMS.find((p) => p.id === d.name);
      expect(source).toBeDefined();
      expect(d.minValue).toBe(source!.min);
      expect(d.maxValue).toBe(source!.max);
      expect(d.defaultValue).toBe(source!.defaultValue);
      expect(d.automationRate).toBe("k-rate");
      expect(d.defaultValue).toBeGreaterThanOrEqual(d.minValue);
      expect(d.defaultValue).toBeLessThanOrEqual(d.maxValue);
    }
  });

  it("tunes semitones and cents as integers — a mouse should not land between them", () => {
    for (const id of ["aCoarse", "aFine", "bCoarse", "bFine", "voices"]) {
      const desc = WAVETABLE_PARAMS.find((p) => p.id === id);
      expect(desc?.kind).toBe("stepped");
      expect(desc?.step).toBe(1);
    }
  });

  it("starts with the whole matrix at zero, so the synth is only what you can see", () => {
    for (const id of MOD_PARAM_IDS.flat()) {
      const desc = WAVETABLE_PARAMS.find((p) => p.id === id);
      expect(desc?.defaultValue).toBe(0);
      expect(desc?.bipolar).toBe(true);
      expect(desc?.min).toBe(-100);
      expect(desc?.max).toBe(100);
    }
  });
});

describe("a sanity pass over the whole voice path", () => {
  it("a table read through a resonant lowpass is still a signal, not a runaway", () => {
    const data = buildWavetable(1); // Pulse — the harshest thing in the box
    const osc = new WavetableOscillator();
    const inc = 220 / SR;
    osc.prepare(data, inc);
    osc.reset();
    const filter = new StereoFilter();
    filter.configure(1, 900, 0.95, 12, SR); // LP 24, near-max resonance, driven
    const out: number[] = [];
    for (let i = 0; i < SR / 4; i++) out.push(filter.processLeft(osc.next(0.5, inc)));
    expect(Number.isFinite(settledRms(out))).toBe(true);
    expect(settledRms(out)).toBeGreaterThan(0.01);
    expect(peak(out)).toBeLessThan(20);
  });
});
