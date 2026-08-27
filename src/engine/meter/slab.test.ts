// SS6 metering slab math + the worklet's process(), driven directly (SS15).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLOATS_PER_SLOT,
  PEAK_OFFSET,
  RMS_OFFSET,
  blockPeakRms,
  blockPeakRmsInto,
  decayed,
  readMeterSlot,
  slabByteLength,
  writeMeterSlot,
} from "./slab";

describe("slab math", () => {
  it("write/read round-trips per slot without crosstalk", () => {
    const view = new Float32Array(4 * FLOATS_PER_SLOT);
    writeMeterSlot(view, 0, 0.9, 0.5);
    writeMeterSlot(view, 2, 0.3, 0.1);
    expect(readMeterSlot(view, 0)).toEqual({ peak: expect.closeTo(0.9), rms: expect.closeTo(0.5) });
    expect(readMeterSlot(view, 1)).toEqual({ peak: 0, rms: 0 });
    expect(readMeterSlot(view, 2).peak).toBeCloseTo(0.3);
  });

  it("blockPeakRms: a full-scale square has peak 1 and rms 1", () => {
    const block = new Float32Array(128).fill(1);
    const { peak, rms } = blockPeakRms([block]);
    expect(peak).toBe(1);
    expect(rms).toBeCloseTo(1);
  });

  it("blockPeakRms: a sine's rms is peak/sqrt(2)", () => {
    const n = 1024;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 8 * i) / n);
    const { peak, rms } = blockPeakRms([sine]);
    expect(peak).toBeCloseTo(1, 2);
    expect(rms).toBeCloseTo(1 / Math.SQRT2, 2);
  });

  it("blockPeakRmsInto: the render-thread form agrees with the object form", () => {
    const n = 256;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = Math.sin((2 * Math.PI * 5 * i) / n);
      right[i] = -0.25;
    }
    const out = new Float32Array(FLOATS_PER_SLOT);
    blockPeakRmsInto([left, right], out);
    const expected = blockPeakRms([left, right]);
    expect(out[PEAK_OFFSET]).toBeCloseTo(expected.peak, 6);
    expect(out[RMS_OFFSET]).toBeCloseTo(expected.rms, 6);
  });

  it("blockPeakRmsInto: an empty block writes zeros, and the buffer is reusable", () => {
    const out = new Float32Array(FLOATS_PER_SLOT);
    blockPeakRmsInto([new Float32Array(64).fill(0.8)], out);
    expect(out[PEAK_OFFSET]).toBeCloseTo(0.8, 6);
    // Same buffer, second block: every field must be overwritten, not merged.
    blockPeakRmsInto([], out);
    expect(out[PEAK_OFFSET]).toBe(0);
    expect(out[RMS_OFFSET]).toBe(0);
  });

  it("decayed: instant attack, exponential release", () => {
    expect(decayed(0.2, 0.9, 0.016)).toBe(0.9);
    const fallen = decayed(0.9, 0, 0.1);
    expect(fallen).toBeLessThan(0.9);
    expect(fallen).toBeGreaterThan(0);
  });
});

// The worklet module extends `AudioWorkletProcessor` and self-registers at
// import time, so the globals are stubbed FIRST and the module imported
// dynamically — same pattern as poly-synth-processor.test.ts.
class FakeProcessorBase {
  readonly port = { onmessage: null, postMessage(): void {} };
}

interface MeterProcessorLike {
  process(inputs: Float32Array[][]): boolean;
}

beforeEach(() => {
  vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
  vi.stubGlobal("registerProcessor", () => undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeProcessor(options: unknown): Promise<MeterProcessorLike> {
  const module = await import("../../worklets/meter-processor");
  const Ctor = module.MeterProcessor as unknown as new (o: unknown) => MeterProcessorLike;
  return new Ctor(options);
}

describe("MeterProcessor.process", () => {
  it("writes its block's peak/rms into its own slot", async () => {
    const sab = new SharedArrayBuffer(slabByteLength(4));
    const view = new Float32Array(sab);
    const processor = await makeProcessor({ processorOptions: { sab, slot: 2 } });
    const left = new Float32Array(128).fill(0.5);
    const right = new Float32Array(128).fill(-0.5);
    expect(processor.process([[left, right]])).toBe(true);
    expect(readMeterSlot(view, 2)).toEqual({ peak: 0.5, rms: expect.closeTo(0.5) });
    expect(readMeterSlot(view, 0)).toEqual({ peak: 0, rms: 0 });
  });

  it("survives a missing input and a missing sab", async () => {
    const processor = await makeProcessor({});
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);
  });

  it("never calls the allocating measurement form (SS12: zero allocation per tick)", async () => {
    // The guardrail, made mechanical: `blockPeakRms` returns a fresh object
    // per call, which is exactly what must not happen once per render quantum
    // per strip. `process` has to use the out-param form.
    const slab = await import("./slab");
    const spy = vi.spyOn(slab, "blockPeakRms");
    const sab = new SharedArrayBuffer(slabByteLength(2));
    const processor = await makeProcessor({ processorOptions: { sab, slot: 0 } });
    processor.process([[new Float32Array(128).fill(0.25)]]);
    processor.process([[new Float32Array(128).fill(0.5)]]);
    expect(spy).not.toHaveBeenCalled();
    expect(readMeterSlot(new Float32Array(sab), 0).peak).toBeCloseTo(0.5, 6);
    spy.mockRestore();
  });
});
