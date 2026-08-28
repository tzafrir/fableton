// `core.eq8` — the response math, and the device that drives eight biquads
// from it. Headless (SS15); the claim that these formulas match a REAL
// browser's `getFrequencyResponse` is measured in e2e/mixer/eq8.spec.ts.

import { describe, expect, it } from "vitest";
import type { DeviceInstance, ParamHandle } from "../../types";
import { validateDefinition } from "../harness";
import {
  BAND_TYPES,
  GAIN_TYPES,
  Q_TYPES,
  bandResponseDb,
  bandTypeFromIndex,
  totalResponseDb,
  type BandSettings,
} from "./eq8/response";
import { EQ8_BAND_COUNT, Eq8, bandParamIds } from "./eq8";
import {
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeBiquadNode,
  fakeServices,
  type FakeAudioContext,
} from "./testing/fakeAudio";

const SR = 48000;

function band(over: Partial<BandSettings> = {}): BandSettings {
  return { type: "bell", freqHz: 1000, gainDb: 0, q: 1, enabled: true, ...over };
}

function rig(): { ctx: FakeAudioContext; instance: DeviceInstance } {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  return { ctx, instance: Eq8.create(asContext(ctx), io, fakeServices()) };
}

function paramPusher(instance: DeviceInstance) {
  const writers = new Map<string, (value: number, when: number) => void>();
  for (const desc of Eq8.params) {
    const handle = {
      desc,
      bindMessage: (write: (value: number, when: number) => void) => {
        writers.set(desc.id, write);
      },
      bindAudioParam: () => undefined,
    } as unknown as ParamHandle;
    instance.connectParam(desc.id, handle);
  }
  return (localId: string, value: number): void => {
    writers.get(localId)?.(value, 0);
  };
}

const biquads = (ctx: FakeAudioContext): FakeBiquadNode[] =>
  ctx.created.filter((n): n is FakeBiquadNode => n instanceof FakeBiquadNode);

describe("the definition", () => {
  it("passes the harness's own validator", () => {
    expect(() => validateDefinition(Eq8)).not.toThrow();
  });

  it("declares five params per band, plus an output trim", () => {
    expect(Eq8.params).toHaveLength(EQ8_BAND_COUNT * 5 + 1);
    for (let i = 0; i < EQ8_BAND_COUNT; i++) {
      const ids = bandParamIds(i);
      for (const id of Object.values(ids)) {
        expect(Eq8.params.some((p) => p.id === id), id).toBe(true);
      }
    }
  });

  it("names its own editor, so the panel is the curve and not a knob grid", () => {
    expect(Eq8.editor).toBe("eq8");
  });
});

describe("bandResponseDb", () => {
  it("is exactly flat for a disabled band, whatever it is set to", () => {
    const off = band({ type: "lowcut", freqHz: 400, gainDb: 12, q: 4, enabled: false });
    for (const hz of [20, 100, 1000, 10000, 20000]) {
      expect(bandResponseDb(off, hz, SR)).toBe(0);
    }
  });

  it("is flat for a bell at 0 dB — which is why a disabled band is one", () => {
    const flat = band({ gainDb: 0 });
    for (const hz of [50, 500, 5000]) {
      expect(bandResponseDb(flat, hz, SR)).toBeCloseTo(0, 9);
    }
  });

  it("puts a bell's full boost at its centre frequency", () => {
    const bell = band({ freqHz: 1000, gainDb: 9, q: 2 });
    expect(bandResponseDb(bell, 1000, SR)).toBeCloseTo(9, 2);
    // ...and lets go of it well away from there.
    expect(bandResponseDb(bell, 100, SR)).toBeLessThan(1);
    expect(bandResponseDb(bell, 10000, SR)).toBeLessThan(1);
  });

  it("cuts as far as it boosts", () => {
    const cut = band({ freqHz: 1000, gainDb: -9, q: 2 });
    expect(bandResponseDb(cut, 1000, SR)).toBeCloseTo(-9, 2);
  });

  it("narrows a bell as Q rises", () => {
    const wide = band({ freqHz: 1000, gainDb: 12, q: 0.5 });
    const narrow = band({ freqHz: 1000, gainDb: 12, q: 8 });
    // Both reach 12 dB at the centre; only the wide one is still doing
    // anything an octave away.
    expect(bandResponseDb(wide, 500, SR)).toBeGreaterThan(bandResponseDb(narrow, 500, SR));
  });

  it("passes the top and kills the bottom for a low cut", () => {
    const cut = band({ type: "lowcut", freqHz: 500, q: Math.SQRT1_2 });
    expect(bandResponseDb(cut, 10000, SR)).toBeCloseTo(0, 1);
    expect(bandResponseDb(cut, 50, SR)).toBeLessThan(-20);
    // Butterworth (Q = 1/sqrt(2)) is -3 dB at the corner, by definition.
    expect(bandResponseDb(cut, 500, SR)).toBeCloseTo(-3, 0);
  });

  it("passes the bottom and kills the top for a high cut", () => {
    const cut = band({ type: "highcut", freqHz: 2000, q: Math.SQRT1_2 });
    expect(bandResponseDb(cut, 100, SR)).toBeCloseTo(0, 1);
    expect(bandResponseDb(cut, 18000, SR)).toBeLessThan(-20);
  });

  it("reads a cut's Q as a quality factor, like every other band", () => {
    // Web Audio would read this one in DECIBELS; the device converts, so the
    // number a user sets means the same thing whatever the band's type.
    const resonant = band({ type: "lowcut", freqHz: 1000, q: 4 });
    expect(bandResponseDb(resonant, 1000, SR)).toBeGreaterThan(3);
    const gentle = band({ type: "lowcut", freqHz: 1000, q: Math.SQRT1_2 });
    expect(bandResponseDb(gentle, 1000, SR)).toBeLessThan(0);
  });

  it("lifts one end and leaves the other alone, for each shelf", () => {
    const low = band({ type: "lowshelf", freqHz: 200, gainDb: 12 });
    expect(bandResponseDb(low, 30, SR)).toBeCloseTo(12, 0);
    expect(bandResponseDb(low, 15000, SR)).toBeCloseTo(0, 1);

    const high = band({ type: "highshelf", freqHz: 4000, gainDb: 12 });
    expect(bandResponseDb(high, 18000, SR)).toBeCloseTo(12, 0);
    expect(bandResponseDb(high, 60, SR)).toBeCloseTo(0, 1);
  });

  it("drops a notch to the floor at its centre and nowhere else", () => {
    const notch = band({ type: "notch", freqHz: 1000, q: 6 });
    expect(bandResponseDb(notch, 1000, SR)).toBeLessThan(-60);
    expect(bandResponseDb(notch, 200, SR)).toBeCloseTo(0, 1);
  });

  it("stays finite at the very bottom of the notch", () => {
    // A true zero is -inf dB, which would take the drawn curve off the canvas
    // (and NaN its way through every later arithmetic).
    const value = bandResponseDb(band({ type: "notch", freqHz: 1000, q: 30 }), 1000, SR);
    expect(Number.isFinite(value)).toBe(true);
  });
});

describe("totalResponseDb", () => {
  it("adds the bands, because they are in series", () => {
    const bands = [
      band({ freqHz: 1000, gainDb: 6, q: 1 }),
      band({ freqHz: 1000, gainDb: 4, q: 1 }),
    ];
    expect(totalResponseDb(bands, 1000, SR)).toBeCloseTo(10, 2);
  });

  it("is flat when every band is", () => {
    const bands = Array.from({ length: EQ8_BAND_COUNT }, () => band());
    for (const hz of [40, 400, 4000]) expect(totalResponseDb(bands, hz, SR)).toBeCloseTo(0, 6);
  });
});

describe("band types", () => {
  it("clamps an out-of-range index rather than returning undefined", () => {
    expect(bandTypeFromIndex(-5)).toBe(BAND_TYPES[0]);
    expect(bandTypeFromIndex(99)).toBe(BAND_TYPES[BAND_TYPES.length - 1]);
  });

  it("says which types actually read gain and Q", () => {
    // Web Audio ignores `gain` on everything but the shelves and the bell,
    // and `Q` on the shelves — the editor greys those controls out rather
    // than letting the user move a number nothing reads.
    expect([...GAIN_TYPES].sort()).toEqual(["bell", "highshelf", "lowshelf"]);
    expect(Q_TYPES.has("lowshelf")).toBe(false);
    expect(Q_TYPES.has("bell")).toBe(true);
  });
});

describe("the device", () => {
  it("builds eight biquads in series", () => {
    const { ctx } = rig();
    expect(biquads(ctx)).toHaveLength(EQ8_BAND_COUNT);
  });

  it("puts an enabled band's type and gain into its node", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    const ids = bandParamIds(1);
    push(ids.on, 1);
    push(ids.type, 4); // High Shelf
    push(ids.gain, 6);
    const node = biquads(ctx)[1]!;
    expect(node.type).toBe("highshelf");
    expect(node.gain.value).toBeCloseTo(6, 3);
  });

  it("makes a DISABLED band exactly transparent, without unwiring it", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    const ids = bandParamIds(2);
    push(ids.type, 0); // Low Cut — a type with no transparent setting
    push(ids.gain, 12);
    push(ids.on, 0);
    const node = biquads(ctx)[2]!;
    // A peaking filter at 0 dB has identical numerator and denominator
    // coefficients: unity, exactly, with no rewire and therefore no click.
    expect(node.type).toBe("peaking");
    expect(node.gain.value).toBeCloseTo(0, 6);
  });

  it("writes a cut's Q in dB and a bell's as a quality factor", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);

    const bell = bandParamIds(4);
    push(bell.on, 1);
    push(bell.type, 2); // Bell
    push(bell.q, 4);
    expect(biquads(ctx)[4]!.Q.value).toBeCloseTo(4, 3);

    const cut = bandParamIds(5);
    push(cut.on, 1);
    push(cut.type, 0); // Low Cut — Web Audio reads Q in dB here
    push(cut.q, 4);
    expect(biquads(ctx)[5]!.Q.value).toBeCloseTo(20 * Math.log10(4), 3);
  });

  it("rewrites Q in the new units when the band's type changes", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    const ids = bandParamIds(6);
    push(ids.on, 1);
    push(ids.type, 2);
    push(ids.q, 2);
    expect(biquads(ctx)[6]!.Q.value).toBeCloseTo(2, 3);
    // Same knob, same number, different node units — and nothing above the
    // device had to know that.
    push(ids.type, 5);
    expect(biquads(ctx)[6]!.Q.value).toBeCloseTo(20 * Math.log10(2), 3);
  });

  it("re-applies the type when a band is switched back on", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    const ids = bandParamIds(3);
    push(ids.type, 3); // Notch
    push(ids.on, 0);
    expect(biquads(ctx)[3]!.type).toBe("peaking");
    push(ids.on, 1);
    expect(biquads(ctx)[3]!.type).toBe("notch");
  });
});
