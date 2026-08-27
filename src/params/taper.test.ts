import { describe, expect, it } from "vitest";
import type { ParamDescriptor } from "../types";
import { assertTaperUsable, clampToDescriptor, fromNormalized, toNormalized } from "./taper";
import { p } from "./descriptors";

const linear: ParamDescriptor = p.continuous("x", "X", { min: -10, max: 10, default: 0 });
const log: ParamDescriptor = p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1000 });
const powed: ParamDescriptor = p.continuous("y", "Y", {
  min: 0,
  max: 100,
  default: 0,
  taper: { pow: 2 },
});

describe("taper mapping (SS4: the ONLY normalization boundary)", () => {
  it("maps linear ranges evenly and inverts exactly", () => {
    expect(toNormalized(linear, -10)).toBe(0);
    expect(toNormalized(linear, 10)).toBe(1);
    expect(toNormalized(linear, 0)).toBeCloseTo(0.5, 12);
    expect(fromNormalized(linear, 0.25)).toBeCloseTo(-5, 12);
  });

  it("maps a log taper geometrically (20 Hz .. 20 kHz midpoint is 632 Hz)", () => {
    expect(fromNormalized(log, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 6);
    expect(toNormalized(log, 20)).toBe(0);
    expect(toNormalized(log, 20000)).toBe(1);
    for (const hz of [20, 100, 440, 1000, 12000, 20000]) {
      expect(fromNormalized(log, toNormalized(log, hz))).toBeCloseTo(hz, 6);
    }
  });

  it("maps a pow taper as normalized^k", () => {
    expect(fromNormalized(powed, 0.5)).toBeCloseTo(25, 12);
    expect(toNormalized(powed, 25)).toBeCloseTo(0.5, 12);
  });

  it("keeps normalized output inside 0..1 for out-of-range reals", () => {
    expect(toNormalized(linear, -1000)).toBe(0);
    expect(toNormalized(linear, 1000)).toBe(1);
    expect(toNormalized(linear, Number.NaN)).toBe(0);
    expect(fromNormalized(linear, 4)).toBe(10);
    expect(fromNormalized(linear, Number.NaN)).toBe(-10);
  });

  it("rejects tapers that cannot map the declared range", () => {
    expect(() =>
      assertTaperUsable(p.continuous("bad", "Bad", { min: 0, max: 10, default: 1, taper: "log" })),
    ).toThrow(/log/);
    expect(() =>
      assertTaperUsable(
        p.continuous("bad2", "Bad", { min: 1, max: 10, default: 1, taper: { pow: 0 } }),
      ),
    ).toThrow(/pow/);
    expect(() => assertTaperUsable(log)).not.toThrow();
  });
});

describe("clampToDescriptor (SS4: loaded values clamp to the descriptor range)", () => {
  it("clamps continuous values and resolves garbage to the default", () => {
    expect(clampToDescriptor(linear, 99)).toBe(10);
    expect(clampToDescriptor(linear, -99)).toBe(-10);
    expect(clampToDescriptor(linear, Number.NaN)).toBe(0);
    expect(clampToDescriptor(linear, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("quantizes stepped params onto the grid without overshooting max", () => {
    const voices = p.stepped("voices", "Voices", { min: 1, max: 16, default: 8, step: 1 });
    expect(clampToDescriptor(voices, 7.4)).toBe(7);
    expect(clampToDescriptor(voices, 7.6)).toBe(8);
    expect(clampToDescriptor(voices, 100)).toBe(16);

    const offGrid = p.stepped("g", "G", { min: 0, max: 1, default: 0, step: 0.3 });
    expect(clampToDescriptor(offGrid, 0.44)).toBeCloseTo(0.3, 9);
    expect(clampToDescriptor(offGrid, 1)).toBeCloseTo(0.9, 9);
  });

  it("rounds enum values to a valid label index", () => {
    const mode = p.enum("mode", "Mode", { labels: ["LP", "HP", "BP"], default: 0 });
    expect(clampToDescriptor(mode, 1.4)).toBe(1);
    expect(clampToDescriptor(mode, 9)).toBe(2);
    expect(clampToDescriptor(mode, -3)).toBe(0);
  });

  it("snaps toggles to their endpoints", () => {
    const on = p.toggle("on", "On");
    expect(clampToDescriptor(on, 0.49)).toBe(0);
    expect(clampToDescriptor(on, 0.5)).toBe(1);
    expect(clampToDescriptor(on, 7)).toBe(1);
  });
});
