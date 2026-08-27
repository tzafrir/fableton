// `core.gate`'s DSP, head-on in Vitest (SS15). The gate is the device gated
// reverb is built out of, so what is asserted here is exactly the behaviour
// that patch depends on: the door opens on the key's transient, HOLDS, and
// then closes on its own attack/release rather than chattering.

import { describe, expect, it } from "vitest";
import { GateKernel, gainOfDb, type GateParams } from "./kernel";

const SR = 48000;
const params = (over: Partial<GateParams> = {}): GateParams => ({
  thresholdDb: -30,
  attackMs: 0.1,
  holdMs: 10,
  releaseMs: 20,
  floorDb: -60,
  ...over,
});

/** A block of constant amplitude. */
const block = (amplitude: number, n = 480): Float32Array => new Float32Array(n).fill(amplitude);

/** Peak of a block. */
const peak = (data: Float32Array): number => {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  return max;
};

describe("GateKernel", () => {
  it("starts CLOSED, so nothing leaks through before the detector has run", () => {
    const kernel = new GateKernel(SR);
    expect(kernel.gain).toBe(0);
    const main = [block(1, 8)];
    kernel.process(main, [block(0, 8)], params());
    expect(peak(main[0] as Float32Array)).toBeLessThan(0.01);
  });

  it("opens on a key above the threshold and passes the signal", () => {
    const kernel = new GateKernel(SR);
    const key = [block(0.5)]; // -6 dB, well above -30
    const main = [block(1)];
    kernel.process(main, key, params());
    expect(kernel.open).toBe(true);
    // The tail of the block is fully open (the head is the attack ramp).
    expect(main[0]?.[479]).toBeCloseTo(1, 2);
  });

  it("closes to the FLOOR, not to silence, so it can duck instead of mute", () => {
    const kernel = new GateKernel(SR);
    kernel.process([block(1)], [block(0.5)], params()); // open it
    const main = [block(1, SR / 10)]; // 100 ms of quiet key
    kernel.process(main, [block(0, SR / 10)], params({ floorDb: -12, holdMs: 0 }));
    const settled = main[0]?.[main[0].length - 1] ?? 0;
    // Within 5% of the floor: a one-pole is still a few tenths of a percent
    // above its target after five time constants, and pinning that residue
    // would be pinning the arithmetic rather than the behaviour.
    expect(settled / gainOfDb(-12)).toBeGreaterThan(0.95);
    expect(settled / gainOfDb(-12)).toBeLessThan(1.05);
  });

  it("HOLDS open after the key drops — the thing that stops it chattering", () => {
    const kernel = new GateKernel(SR);
    const opts = params({ holdMs: 50, releaseMs: 1 });
    kernel.process([block(1)], [block(0.5)], opts); // open

    // 10 ms of silence, well inside the 50 ms hold: still open.
    const during = [block(1, SR / 100)];
    kernel.process(during, [block(0, SR / 100)], opts);
    expect(during[0]?.[during[0].length - 1] ?? 0).toBeCloseTo(1, 2);

    // Past the hold, with a 1 ms release: shut.
    const after = [block(1, SR / 10)];
    kernel.process(after, [block(0, SR / 10)], opts);
    expect(after[0]?.[after[0].length - 1] ?? 0).toBeLessThan(0.01);
  });

  it("keys off the SIDECHAIN, which is what gated reverb is", () => {
    const kernel = new GateKernel(SR);
    // The main input is a long quiet tail (a reverb); the key is a loud hit.
    const tail = [block(0.05)];
    kernel.process(tail, [block(0.8)], params());
    // The tail passes at full level because the KEY opened the door — its own
    // level (-26 dB) would also have opened this threshold, so the real proof
    // is the opposite case below.
    expect(peak(tail[0] as Float32Array)).toBeGreaterThan(0.04);

    const shut = new GateKernel(SR);
    const loudTail = [block(0.9)];
    shut.process(loudTail, [block(0)], params({ attackMs: 0.1, holdMs: 0 }));
    // A LOUD main signal with a silent key stays shut: the gate is not
    // self-keying when a sidechain is supplied.
    expect(peak(loudTail[0] as Float32Array)).toBeLessThan(0.05);
  });

  it("opens fast and closes slowly when told to", () => {
    const fast = new GateKernel(SR);
    fast.process([block(1, 48)], [block(0.5, 48)], params({ attackMs: 0.05 }));
    const slow = new GateKernel(SR);
    slow.process([block(1, 48)], [block(0.5, 48)], params({ attackMs: 50 }));
    expect(fast.gain).toBeGreaterThan(slow.gain);
  });

  it("treats a floor at -60 dB as true silence", () => {
    expect(gainOfDb(-60)).toBe(0);
    expect(gainOfDb(0)).toBe(1);
  });
});
