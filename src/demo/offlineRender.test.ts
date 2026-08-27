// The measurement half of the SS15 buffer proof. `renderDemoOffline` itself
// needs a real `OfflineAudioContext` (e2e/audio/offline-render.spec.ts), but
// the arithmetic every one of that spec's assertions rests on is pure and
// belongs in a headless test — otherwise a wrong RMS or window bucket would
// make the milestone's audibility claim pass vacuously.
import { describe, expect, it } from "vitest";
import { RMS_WINDOW_SECONDS, analyze, type AnalyzableBuffer } from "./offlineRender";

const SR = 1000; // 1 kHz: one RMS window is exactly 50 samples

function buffer(channels: readonly number[][], sampleRate = SR): AnalyzableBuffer {
  const data = channels.map((c) => Float32Array.from(c));
  return {
    length: data[0]?.length ?? 0,
    sampleRate,
    numberOfChannels: data.length,
    getChannelData: (channel: number) => data[channel] ?? new Float32Array(0),
  };
}

describe("analyze", () => {
  it("reports silence as all zeroes", () => {
    const result = analyze(buffer([new Array<number>(100).fill(0)]));
    expect(result.peakAbs).toBe(0);
    expect(result.rms).toBe(0);
    expect(result.clippedSamples).toBe(0);
    expect(result.windowRms).toEqual([0, 0]);
  });

  it("takes the peak as the largest magnitude across every channel", () => {
    const result = analyze(
      buffer([
        [0.1, -0.2, 0.3],
        [0.05, 0.9, -0.95],
      ]),
    );
    expect(result.peakAbs).toBeCloseTo(0.95, 6);
  });

  it("computes RMS over every sample of every channel", () => {
    // Two channels of constant 0.5 and constant -1 -> sqrt((0.25 + 1) / 2).
    const result = analyze(
      buffer([new Array<number>(50).fill(0.5), new Array<number>(50).fill(-1)]),
    );
    expect(result.rms).toBeCloseTo(Math.sqrt((0.25 + 1) / 2), 6);
    expect(result.clippedSamples).toBe(0); // exactly full scale is not over it
  });

  it("counts samples past full scale", () => {
    const result = analyze(buffer([[0.99, 1, -1, 1.0001, -2, 0]]));
    expect(result.clippedSamples).toBe(2);
    expect(result.peakAbs).toBe(2);
  });

  it("buckets windowRms by RMS_WINDOW_SECONDS, in order", () => {
    const windowSamples = Math.round(RMS_WINDOW_SECONDS * SR);
    expect(windowSamples).toBe(50);
    const samples = [
      ...new Array<number>(windowSamples).fill(0), // silent window
      ...new Array<number>(windowSamples).fill(0.5), // loud window
      ...new Array<number>(windowSamples).fill(0), // silent again
    ];
    const result = analyze(buffer([samples]));
    expect(result.windowRms).toHaveLength(3);
    expect(result.windowRms[0]).toBe(0);
    expect(result.windowRms[1]).toBeCloseTo(0.5, 6);
    expect(result.windowRms[2]).toBe(0);
  });

  it("keeps a short trailing window rather than padding it with zeroes", () => {
    const samples = [...new Array<number>(50).fill(0), ...new Array<number>(10).fill(1)];
    const result = analyze(buffer([samples]));
    expect(result.windowRms).toHaveLength(2);
    expect(result.windowRms[1]).toBeCloseTo(1, 6); // averaged over 10, not 50
  });

  it("averages each window across channels, not per channel", () => {
    const result = analyze(buffer([new Array<number>(50).fill(1), new Array<number>(50).fill(0)]));
    expect(result.windowRms).toEqual([Math.sqrt(0.5)]);
  });

  it("reports hfRatio as the first-difference energy share, rising with frequency", () => {
    // The spectral half of the SS15 buffer proof: two renders that differ only
    // in the filter's cutoff must differ HERE, so the measure has to track
    // high-frequency content and nothing else. For a sine at `f` the exact
    // value is `(2 sin(pi f / fs))^2`.
    const sine = (freq: number, n = 4000): number[] =>
      Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / SR));
    const expected = (freq: number): number => (2 * Math.sin((Math.PI * freq) / SR)) ** 2;

    const low = analyze(buffer([sine(20)])).hfRatio;
    const high = analyze(buffer([sine(300)])).hfRatio;
    expect(low).toBeCloseTo(expected(20), 3);
    expect(high).toBeCloseTo(expected(300), 3);
    expect(high).toBeGreaterThan(low * 10);

    // DC has no high-frequency energy at all; silence is 0, not NaN.
    expect(analyze(buffer([new Array<number>(100).fill(0.5)])).hfRatio).toBeCloseTo(0, 9);
    expect(analyze(buffer([new Array<number>(100).fill(0)])).hfRatio).toBe(0);
  });

  it("handles an empty buffer without dividing by zero", () => {
    const result = analyze(buffer([[]]));
    expect(result.rms).toBe(0);
    expect(result.peakAbs).toBe(0);
    expect(result.windowRms).toEqual([]);
    expect(result.hfRatio).toBe(0);
  });
});
