// The visualisers' math, head-on (SS15). No canvas, no analyser, no browser.

import { describe, expect, it } from "vitest";
import {
  LevelHistory,
  MAX_HZ,
  MIN_HZ,
  amplitudeToHeight,
  binHz,
  hzAtPosition,
  levelOf,
  logPosition,
  spectrumBands,
} from "./analysis";

describe("the log frequency axis", () => {
  it("puts the ends at the ends and is monotonic between", () => {
    expect(logPosition(MIN_HZ)).toBe(0);
    expect(logPosition(MAX_HZ)).toBe(1);
    expect(logPosition(10)).toBe(0); // clamped, not negative
    expect(logPosition(30000)).toBe(1);
    expect(logPosition(200)).toBeLessThan(logPosition(2000));
  });

  it("gives every octave the same width — the whole point of a log axis", () => {
    const octave = (hz: number): number => logPosition(hz * 2) - logPosition(hz);
    // 40->80 Hz and 5k->10k are one octave each, and must be equally wide.
    expect(octave(40)).toBeCloseTo(octave(5000), 10);
  });

  it("round-trips through hzAtPosition", () => {
    for (const hz of [50, 440, 1000, 12000]) {
      expect(hzAtPosition(logPosition(hz))).toBeCloseTo(hz, 6);
    }
  });
});

describe("binHz", () => {
  it("is sampleRate/fftSize per bin", () => {
    expect(binHz(0, 48000, 2048)).toBe(0);
    expect(binHz(1, 48000, 2048)).toBeCloseTo(23.4375, 6);
    expect(binHz(1024, 48000, 2048)).toBe(24000); // Nyquist
  });
});

describe("spectrumBands", () => {
  const SR = 48000;
  const FFT = 2048;

  /** A frequency-data buffer with one loud bin at `hz`. */
  function spike(hz: number, value = 255): Uint8Array {
    const data = new Uint8Array(FFT / 2);
    data[Math.round((hz * FFT) / SR)] = value;
    return data;
  }

  it("puts a 1 kHz spike in the band that covers 1 kHz, and nowhere else", () => {
    const bands = spectrumBands(spike(1000), SR, FFT, 64);
    const loud = [...bands].map((v, i) => ({ v, i })).filter((b) => b.v > 0);
    expect(loud).toHaveLength(1);
    const band = loud[0]!.i;
    expect(hzAtPosition(band / 64)).toBeLessThanOrEqual(1000);
    expect(hzAtPosition((band + 1) / 64)).toBeGreaterThanOrEqual(1000);
  });

  it("normalizes 0..255 to 0..1", () => {
    expect(Math.max(...spectrumBands(spike(1000, 255), SR, FFT, 64))).toBe(1);
    expect(Math.max(...spectrumBands(spike(1000, 128), SR, FFT, 64))).toBeCloseTo(128 / 255, 6);
  });

  it("takes the MAX in a band, so one loud partial is not averaged away", () => {
    // Two bins in the top octave, where a band spans many bins.
    const data = new Uint8Array(FFT / 2);
    data[Math.round((15000 * FFT) / SR)] = 255;
    data[Math.round((15100 * FFT) / SR)] = 10;
    const bands = spectrumBands(data, SR, FFT, 32);
    expect(Math.max(...bands)).toBe(1);
  });

  it("leaves no band unread at the bottom, where bins are wider than bands", () => {
    // A 30 Hz band is narrower than a 23 Hz bin, so naive floor/ceil maths
    // can produce an empty range and a permanent hole in the low end.
    const data = new Uint8Array(FFT / 2).fill(200);
    const bands = spectrumBands(data, SR, FFT, 128);
    expect([...bands].every((v) => v > 0)).toBe(true);
  });

  it("writes into a reused buffer rather than allocating per frame", () => {
    const out = new Float32Array(64);
    expect(spectrumBands(spike(1000), SR, FFT, 64, out)).toBe(out);
    // A buffer of the wrong size is not silently mis-filled.
    expect(spectrumBands(spike(1000), SR, FFT, 32, out)).not.toBe(out);
  });
});

describe("levelOf", () => {
  it("reads 128 as silence (the byte time-domain zero)", () => {
    expect(levelOf(new Uint8Array(64).fill(128))).toEqual({ peak: 0, rms: 0 });
  });

  it("reads full-scale as 1, and a square wave's rms as its peak", () => {
    const square = new Uint8Array(64);
    for (let i = 0; i < 64; i++) square[i] = i % 2 === 0 ? 255 : 1;
    const { peak, rms } = levelOf(square);
    expect(peak).toBeGreaterThan(0.98);
    expect(rms).toBeCloseTo(peak, 1);
  });

  it("reports rms BELOW peak for a signal that is not always at its peak", () => {
    const pulse = new Uint8Array(64).fill(128);
    pulse[0] = 255;
    const { peak, rms } = levelOf(pulse);
    expect(peak).toBeCloseTo(0.992, 2);
    expect(rms).toBeLessThan(peak / 4);
  });

  it("survives an empty buffer", () => {
    expect(levelOf(new Uint8Array(0))).toEqual({ peak: 0, rms: 0 });
  });
});

describe("amplitudeToHeight", () => {
  it("puts full scale at the top and the floor at the bottom", () => {
    expect(amplitudeToHeight(1)).toBe(1);
    expect(amplitudeToHeight(0)).toBe(0);
    expect(amplitudeToHeight(10 ** (-60 / 20))).toBe(0);
  });

  it("is a dB scale: -6 dB is half the DECIBEL range, not half the height", () => {
    // The reason it exists: on a linear scale -20 dBFS — most of a mix, most
    // of the time — sits in the bottom tenth of the graph.
    expect(amplitudeToHeight(10 ** (-30 / 20))).toBeCloseTo(0.5, 6);
    expect(amplitudeToHeight(10 ** (-6 / 20))).toBeCloseTo(0.9, 6);
  });
});

describe("LevelHistory", () => {
  it("reads oldest-first and grows until it is full", () => {
    const h = new LevelHistory(4);
    h.push(0.1, 0.05);
    h.push(0.2, 0.1);
    expect(h.length).toBe(2);
    expect(h.at(0).peak).toBeCloseTo(0.1, 6);
    expect(h.at(1).peak).toBeCloseTo(0.2, 6);
  });

  it("scrolls once full: the oldest sample falls off the left", () => {
    const h = new LevelHistory(3);
    for (const v of [1, 2, 3, 4, 5]) h.push(v, v);
    expect(h.length).toBe(3);
    expect([h.at(0).peak, h.at(1).peak, h.at(2).peak]).toEqual([3, 4, 5]);
  });

  it("returns zeros outside its range instead of throwing", () => {
    const h = new LevelHistory(2);
    h.push(1, 1);
    expect(h.at(-1)).toEqual({ peak: 0, rms: 0 });
    expect(h.at(5)).toEqual({ peak: 0, rms: 0 });
  });

  it("clears back to empty", () => {
    const h = new LevelHistory(2);
    h.push(1, 1);
    h.clear();
    expect(h.length).toBe(0);
  });

  it("tolerates a zero capacity (a panel measured before layout)", () => {
    const h = new LevelHistory(0);
    h.push(1, 1);
    expect(h.length).toBe(0);
  });
});
