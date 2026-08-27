// SS18-M4 device library, headless (SS15): definition validity for every
// core device, the compressor kernel's actual dynamics, and the pure curve
// generators. (Wiring-into-a-graph is covered by the harness's own tests
// plus the M4 e2e; DSP-through-real-audio by the offline export probe.)

import { describe, expect, it } from "vitest";
import { validateDefinition } from "../harness/registry";
import { CORE_DEVICES } from "./index";
import { CompressorKernel, dbOf, gainOfDb, smoothingCoeff } from "./compressor/kernel";
import { makeSaturationCurve } from "./saturator";
import { makeNoise } from "./reverb";
import { midiToHz, pluckShapeFromIndex } from "./pluck";

describe("the SS18-M4 library", () => {
  it("ships eight valid definitions: 2 instruments + 6 effects", () => {
    expect(CORE_DEVICES.length).toBe(8);
    for (const def of CORE_DEVICES) expect(() => validateDefinition(def)).not.toThrow();
    const instruments = CORE_DEVICES.filter((d) => d.kind === "instrument");
    const effects = CORE_DEVICES.filter((d) => d.kind === "audioEffect");
    expect(instruments.map((d) => d.id).sort()).toEqual(["core.pluck", "core.poly-synth"]);
    expect(effects.length).toBe(6);
  });

  it("exactly the compressor declares the SS6 sidechain port", () => {
    const withSc = CORE_DEVICES.filter((d) => d.audioIn.some((port) => port.id === "sc"));
    expect(withSc.map((d) => d.id)).toEqual(["core.compressor"]);
    const sc = withSc[0]?.audioIn.find((port) => port.id === "sc");
    expect(sc?.optional).toBe(true);
  });

  it("every param id is unique within its definition (SS7 public API)", () => {
    for (const def of CORE_DEVICES) {
      const ids = def.params.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("compressor kernel", () => {
  const SR = 48000;
  const block = (value: number, n = 480): Float32Array => new Float32Array(n).fill(value);
  const params = { thresholdDb: -20, ratio: 4, attackMs: 0, releaseMs: 0, makeupDb: 0 };

  it("passes signal below threshold untouched", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(0.05)]; // -26 dB, below -20
    kernel.process(main, main, params);
    expect(main[0]?.[400]).toBeCloseTo(0.05, 5);
    expect(kernel.reductionDb).toBe(0);
  });

  it("compresses above threshold at the stated ratio", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(1)]; // 0 dB, 20 dB over -> reduction = 20 * (1 - 1/4) = 15 dB
    kernel.process(main, main, params);
    expect(kernel.reductionDb).toBeCloseTo(15, 1);
    expect(main[0]?.[400]).toBeCloseTo(gainOfDb(-15), 2);
  });

  it("keys off the SIDECHAIN signal, not the main one", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(0.05)]; // quiet main
    const key = [block(1)]; // loud key
    kernel.process(main, key, params);
    // The quiet main is ducked by the loud key: that IS sidechain pumping.
    expect(kernel.reductionDb).toBeCloseTo(15, 1);
    expect(main[0]?.[400]).toBeCloseTo(0.05 * gainOfDb(-15), 3);
  });

  it("attack smooths the onset; instant attack settles immediately", () => {
    // 100 ms of full-scale input against a 50 ms attack: the envelope is
    // still rising, so reduction is present but short of the settled 15 dB.
    const slowKernel = new CompressorKernel(SR);
    const slow = { ...params, attackMs: 50 };
    const main = [block(1, 4800)];
    slowKernel.process(main, main, slow);
    expect(slowKernel.reductionDb).toBeGreaterThan(0);
    expect(slowKernel.reductionDb).toBeLessThan(15);

    const fastKernel = new CompressorKernel(SR);
    const fastMain = [block(1, 4800)];
    fastKernel.process(fastMain, fastMain, params); // attackMs: 0
    expect(fastKernel.reductionDb).toBeCloseTo(15, 1);
  });

  it("makeup applies as a plain output gain", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(0.05)];
    kernel.process(main, main, { ...params, makeupDb: 6 });
    expect(main[0]?.[400]).toBeCloseTo(0.05 * gainOfDb(6), 4);
  });

  it("helpers: dbOf/gainOfDb round-trip; coeff bounds sane", () => {
    expect(dbOf(gainOfDb(-12))).toBeCloseTo(-12, 5);
    expect(smoothingCoeff(0, SR)).toBe(0);
    expect(smoothingCoeff(10, SR)).toBeGreaterThan(0.99);
    expect(smoothingCoeff(10, SR)).toBeLessThan(1);
  });
});

describe("pure generators", () => {
  it("saturation curve is odd, bounded, monotonic", () => {
    const curve = makeSaturationCurve(257);
    expect(curve[128]).toBeCloseTo(0, 6); // center = 0
    expect(curve[0]).toBeCloseTo(-1, 3);
    expect(curve[256]).toBeCloseTo(1, 3);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    }
  });

  it("reverb noise is deterministic per seed (SS12 reproducible renders)", () => {
    const a = makeNoise(1234);
    const b = makeNoise(1234);
    const c = makeNoise(99);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
  });

  it("pluck helpers: A440 and shape clamping", () => {
    expect(midiToHz(69)).toBeCloseTo(440);
    expect(midiToHz(57)).toBeCloseTo(220);
    expect(pluckShapeFromIndex(-3)).toBe("triangle");
    expect(pluckShapeFromIndex(99)).toBe("sawtooth");
  });
});
