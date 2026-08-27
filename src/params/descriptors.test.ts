import { describe, expect, it } from "vitest";
import type { ParamDescriptor } from "../types";
import { p } from "./descriptors";
import { dbSilenceFloor } from "./text";
import { fromNormalized } from "./taper";

describe("descriptor factories (SS4/SS14 `p.*`)", () => {
  it("p.hz formats and parses loose frequency entry", () => {
    const cutoff = p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1200 });
    expect(cutoff.kind).toBe("continuous");
    expect(cutoff.taper).toBe("log");
    expect(cutoff.unit).toBe("Hz");
    expect(cutoff.toText(1200)).toBe("1.20 kHz");
    expect(cutoff.toText(440)).toBe("440 Hz");
    expect(cutoff.toText(6.5)).toBe("6.50 Hz");
    expect(cutoff.fromText("1.2k")).toBeCloseTo(1200, 9);
    expect(cutoff.fromText("440 hz")).toBe(440);
    expect(cutoff.fromText("  2.5 kHz ")).toBeCloseTo(2500, 9);
    expect(cutoff.fromText("banana")).toBeNull();
    expect(cutoff.fromText("")).toBeNull();
    expect(cutoff.fromText("12 furlongs")).toBeNull();
  });

  it("p.db reads out in dB and understands -inf at the bottom of a fader", () => {
    const vol = p.db("vol", "Volume", { min: -70, max: 6, default: 0 });
    expect(vol.toText(-6)).toBe("-6.0 dB");
    expect(vol.toText(-70)).toBe("-inf dB");
    expect(vol.fromText("-6db")).toBe(-6);
    expect(vol.fromText("-inf")).toBe(-70);
    expect(vol.fromText("+3")).toBe(3);
  });

  it("a dB readout of -inf is the single silence contract every consumer reads", () => {
    // SS4 makes `toText` the sanctioned readout of the real value, so "-inf dB"
    // at the bottom of a range is a promise the DSP has to keep. `dbSilenceFloor`
    // is that promise in one place — the harness's gain fast path and the
    // worklet's own dB->linear conversion both apply it (see
    // deviceInstance.test.ts and poly-synth-processor.test.ts).
    const gain = p.db("gain", "Gain", { min: -60, max: 6, default: 0 });
    expect(gain.toText(gain.min)).toBe("-inf dB");
    expect(dbSilenceFloor(gain.min)).toBe(-60);

    // A range too narrow to have a silent end reads as a number instead.
    const trim = p.db("trim", "Trim", { min: -12, max: 12, default: 0 });
    expect(trim.toText(trim.min)).toBe("-12.0 dB");
    expect(dbSilenceFloor(trim.min)).toBeUndefined();
  });

  it("p.pan is bipolar with an L/C/R readout", () => {
    const pan = p.pan("pan");
    expect(pan.bipolar).toBe(true);
    expect(pan.min).toBe(-1);
    expect(pan.max).toBe(1);
    expect(pan.toText(0)).toBe("C");
    expect(pan.toText(-0.5)).toBe("50L");
    expect(pan.toText(0.25)).toBe("25R");
    expect(pan.fromText("50R")).toBeCloseTo(0.5, 9);
    expect(pan.fromText("C")).toBe(0);
    expect(pan.fromText("-0.25")).toBeCloseTo(-0.25, 9);
  });

  it("p.enum values are label indices", () => {
    const mode = p.enum("mode", "Mode", { labels: ["LP12", "LP24", "HP"], default: 1 });
    expect(mode.kind).toBe("enum");
    expect(mode.min).toBe(0);
    expect(mode.max).toBe(2);
    expect(mode.defaultValue).toBe(1);
    expect(mode.toText(2)).toBe("HP");
    expect(mode.fromText("lp24")).toBe(1);
    expect(mode.fromText("nope")).toBeNull();
  });

  it("p.toggle accepts a boolean default and reads out on/off", () => {
    const on = p.toggle("on", "Device On", { default: true });
    expect(on.kind).toBe("toggle");
    expect(on.defaultValue).toBe(1);
    expect(on.toText(1)).toBe("On");
    expect(on.toText(0)).toBe("Off");
    expect(on.fromText("off")).toBe(0);
    expect(on.fromText("TRUE")).toBe(1);
    expect(on.fromText("maybe")).toBeNull();
  });

  it("p.ms, p.percent and p.semitones carry sensible defaults", () => {
    const attack = p.ms("attack", "Attack", { min: 0.5, max: 2000, default: 10 });
    expect(attack.taper).toBe("log");
    expect(attack.toText(10)).toBe("10.0 ms");
    expect(attack.toText(1500)).toBe("1.50 s");
    expect(attack.fromText("1.5s")).toBeCloseTo(1500, 9);

    const mix = p.percent("mix", "Mix", { default: 50 });
    expect(mix.min).toBe(0);
    expect(mix.max).toBe(100);
    expect(mix.toText(50)).toBe("50 %");
    expect(mix.fromText("35%")).toBe(35);

    const detune = p.semitones("detune", "Detune", { min: -24, max: 24, default: 0 });
    expect(detune.bipolar).toBe(true);
    expect(detune.toText(3)).toBe("+3 st");
    expect(detune.fromText("-5 st")).toBe(-5);
  });

  it("toText is total across the whole range of every factory (SS4)", () => {
    const descriptors: ParamDescriptor[] = [
      p.hz("a", "A", { min: 20, max: 20000, default: 1000 }),
      p.db("b", "B", { min: -70, max: 6, default: 0 }),
      p.ms("c", "C", { min: 0.5, max: 4000, default: 20 }),
      p.percent("d", "D", { default: 0 }),
      p.semitones("e", "E", { min: -24, max: 24, default: 0 }),
      p.pan("f"),
      p.stepped("g", "G", { min: 1, max: 16, default: 4, step: 1 }),
      p.enum("h", "H", { labels: ["one", "two"], default: 0 }),
      p.toggle("i", "I"),
      p.continuous("j", "J", { min: 1, max: 20, default: 4, unit: ":1" }),
    ];
    for (const desc of descriptors) {
      for (let step = 0; step <= 20; step += 1) {
        const value = fromNormalized(desc, step / 20);
        const text = desc.toText(value);
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain("NaN");
      }
    }
  });

  it("lets a device override the generated readout", () => {
    const ratio = p.continuous("ratio", "Ratio", {
      min: 1,
      max: 20,
      default: 4,
      toText: (v) => `${v.toFixed(1)}:1`,
      fromText: (s) => (s === "inf" ? 20 : Number.parseFloat(s)),
    });
    expect(ratio.toText(4)).toBe("4.0:1");
    expect(ratio.fromText("inf")).toBe(20);
  });
});

describe("the SS14 playbook spellings", () => {
  it("builds the stereo-delay params exactly as SS14 writes them", () => {
    // Verbatim from the SS14 one-file delay — `p.time` / `p.pct` and the
    // `defaultValue:` spelling, from the same `p` a core device imports.
    const params = [
      p.time("timeL", "Time L", { min: 1, max: 2000, defaultValue: 250 }),
      p.time("timeR", "Time R", { min: 1, max: 2000, defaultValue: 375 }),
      p.pct("feedback", "Feedback", { defaultValue: 35, max: 95 }),
      p.pct("mix", "Mix", { defaultValue: 25 }),
    ];
    expect(params.map((d) => [d.id, d.defaultValue, d.min, d.max])).toEqual([
      ["timeL", 250, 1, 2000],
      ["timeR", 375, 1, 2000],
      ["feedback", 35, 0, 95],
      ["mix", 25, 0, 100],
    ]);
    expect(params[0]?.unit).toBe("ms");
    expect(params[0]?.taper).toBe("log");
    expect(params[3]?.unit).toBe("%");
  });

  it("pct / st / time are the same factories as percent / semitones / ms", () => {
    expect(p.pct).toBe(p.percent);
    expect(p.st).toBe(p.semitones);
    expect(p.time).toBe(p.ms);
  });

  it("accepts either spelling of the default", () => {
    expect(p.hz("c", "C", { min: 20, max: 20000, default: 1200 }).defaultValue).toBe(1200);
    expect(p.hz("c", "C", { min: 20, max: 20000, defaultValue: 1200 }).defaultValue).toBe(1200);
  });
});
