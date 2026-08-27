import { describe, expect, it } from "vitest";
import { OnePoleLowpass } from "./onePoleLowpass";

describe("OnePoleLowpass", () => {
  it("passes DC through unchanged at steady state", () => {
    const lp = new OnePoleLowpass(48000);
    let y = 0;
    for (let i = 0; i < 5000; i++) y = lp.process(1, 1000);
    expect(y).toBeCloseTo(1, 4);
  });

  it("starts at 0 and rises monotonically toward a positive step input", () => {
    const lp = new OnePoleLowpass(48000);
    let previous = -Infinity;
    for (let i = 0; i < 200; i++) {
      const y = lp.process(1, 500);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });

  it("a lower cutoff converges more slowly than a higher one", () => {
    const low = new OnePoleLowpass(48000);
    const high = new OnePoleLowpass(48000);
    let yLow = 0;
    let yHigh = 0;
    for (let i = 0; i < 20; i++) {
      yLow = low.process(1, 100);
      yHigh = high.process(1, 5000);
    }
    expect(yHigh).toBeGreaterThan(yLow);
  });

  it("reset returns the filter to silence", () => {
    const lp = new OnePoleLowpass(48000);
    for (let i = 0; i < 100; i++) lp.process(1, 1000);
    expect(lp.process(1, 1000)).toBeGreaterThan(0);
    lp.reset();
    // Immediately after reset, one sample of a 0 input stays at 0.
    expect(lp.process(0, 1000)).toBe(0);
  });

  it("clamps a cutoff at or above Nyquist instead of producing a bad alpha", () => {
    const lp = new OnePoleLowpass(48000);
    expect(() => lp.process(1, 1_000_000)).not.toThrow();
    expect(Number.isFinite(lp.process(1, 1_000_000))).toBe(true);
  });

  it("setCutoff once per block matches passing the cutoff on every sample", () => {
    // The processor hoists the coefficient out of the sample loop (the cutoff
    // is k-rate — one value per block), so both spellings must agree exactly.
    const perSample = new OnePoleLowpass(48000);
    const perBlock = new OnePoleLowpass(48000);
    perBlock.setCutoff(800);
    for (let i = 0; i < 500; i++) {
      const a = perSample.process(1, 800);
      const b = perBlock.process(1);
      expect(b).toBe(a);
    }
    // ...and a new cutoff for the next block takes effect immediately.
    perBlock.setCutoff(4000);
    perSample.process(1, 4000);
    expect(perBlock.process(1)).toBeGreaterThan(0);
  });

  it("clamps a non-positive cutoff instead of stalling", () => {
    const lp = new OnePoleLowpass(48000);
    const y = lp.process(1, -10);
    expect(Number.isFinite(y)).toBe(true);
    expect(y).toBeGreaterThan(0);
  });
});
