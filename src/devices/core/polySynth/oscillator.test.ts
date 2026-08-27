import { describe, expect, it } from "vitest";
import {
  OSCILLATOR_SHAPES,
  midiToFrequencyHz,
  oscillatorSample,
  shapeFromIndex,
} from "./oscillator";

describe("shapeFromIndex", () => {
  it("rounds and clamps into range", () => {
    expect(shapeFromIndex(0)).toBe("sine");
    expect(shapeFromIndex(1.2)).toBe("square");
    expect(shapeFromIndex(2.6)).toBe("triangle");
    expect(shapeFromIndex(-5)).toBe("sine");
    expect(shapeFromIndex(99)).toBe("triangle");
  });

  it("covers every declared shape", () => {
    OSCILLATOR_SHAPES.forEach((shape, index) => {
      expect(shapeFromIndex(index)).toBe(shape);
    });
  });
});

describe("oscillatorSample", () => {
  it("sine matches Math.sin at known phases", () => {
    expect(oscillatorSample("sine", 0)).toBeCloseTo(0);
    expect(oscillatorSample("sine", 0.25)).toBeCloseTo(1);
    expect(oscillatorSample("sine", 0.75)).toBeCloseTo(-1);
  });

  it("square is +1 for the first half, -1 for the second", () => {
    expect(oscillatorSample("square", 0)).toBe(1);
    expect(oscillatorSample("square", 0.49)).toBe(1);
    expect(oscillatorSample("square", 0.5)).toBe(-1);
    expect(oscillatorSample("square", 0.99)).toBe(-1);
  });

  it("sawtooth ramps linearly from -1 to 1", () => {
    expect(oscillatorSample("sawtooth", 0)).toBeCloseTo(-1);
    expect(oscillatorSample("sawtooth", 0.5)).toBeCloseTo(0);
    expect(oscillatorSample("sawtooth", 1)).toBeCloseTo(-1); // wraps
  });

  it("triangle rises then falls symmetrically, peaking at the quarter phases", () => {
    expect(oscillatorSample("triangle", 0)).toBeCloseTo(-1);
    expect(oscillatorSample("triangle", 0.25)).toBeCloseTo(0);
    expect(oscillatorSample("triangle", 0.5)).toBeCloseTo(1);
    expect(oscillatorSample("triangle", 0.75)).toBeCloseTo(0);
  });

  it("wraps out-of-range phases the same as their fractional part", () => {
    expect(oscillatorSample("sine", 1.25)).toBeCloseTo(oscillatorSample("sine", 0.25));
    expect(oscillatorSample("sawtooth", 2.5)).toBeCloseTo(oscillatorSample("sawtooth", 0.5));
  });
});

describe("midiToFrequencyHz", () => {
  it("A4 (69) is 440 Hz", () => {
    expect(midiToFrequencyHz(69)).toBeCloseTo(440);
  });

  it("octaves double/halve the frequency", () => {
    expect(midiToFrequencyHz(81)).toBeCloseTo(880); // +1 octave
    expect(midiToFrequencyHz(57)).toBeCloseTo(220); // -1 octave
  });
});
