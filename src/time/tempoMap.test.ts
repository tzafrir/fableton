import { afterEach, describe, expect, it, vi } from "vitest";
import { PPQ } from "../types";
import { createFixedTempoMap, createTempoMap } from "./tempoMap";

describe("createFixedTempoMap", () => {
  it("secondsAt(0) === 0", () => {
    const map = createFixedTempoMap(120);
    expect(map.secondsAt(0)).toBe(0);
  });

  it("converts one quarter note at 120bpm to exactly 0.5s", () => {
    const map = createFixedTempoMap(120);
    expect(map.secondsAt(PPQ)).toBeCloseTo(0.5, 12);
  });

  it("converts one bar (4 quarters) at 120bpm to 2s", () => {
    const map = createFixedTempoMap(120);
    expect(map.secondsAt(PPQ * 4)).toBeCloseTo(2, 12);
  });

  it("scales linearly with tempo — 60bpm doubles the duration of 120bpm", () => {
    const at120 = createFixedTempoMap(120).secondsAt(PPQ * 8);
    const at60 = createFixedTempoMap(60).secondsAt(PPQ * 8);
    expect(at60).toBeCloseTo(at120 * 2, 9);
  });

  it("ticksAt is the (rounded) inverse of secondsAt", () => {
    const map = createFixedTempoMap(120);
    for (const tick of [0, 1, 240, 960, 1234, 3840, 100000]) {
      expect(map.ticksAt(map.secondsAt(tick))).toBe(tick);
    }
  });

  it("ticksAt rounds to an integer for arbitrary seconds", () => {
    const map = createFixedTempoMap(97);
    const ticks = map.ticksAt(1.23456789);
    expect(Number.isInteger(ticks)).toBe(true);
  });

  it("ticksAt rounds to NEAREST, not toward zero", () => {
    // Load-bearing, not cosmetic: the scheduler turns a horizon in seconds into
    // a window end with this call and compares it against `loop.end` with `>=`
    // precisely because it rounds (src/engine/transport/transport.ts). Flooring
    // instead would shift the playhead, every window end and the brace
    // detection by up to a tick.
    const map = createFixedTempoMap(120); // 960 ticks per 0.5 s => 1920 ticks/s
    expect(map.ticksAt(0.1234)).toBe(237); // raw 236.928 — rounds UP
    expect(map.ticksAt(0.1)).toBe(192); // exact, unchanged
    expect(map.ticksAt(0.12)).toBe(230); // raw 230.4 — rounds DOWN
    // Half a tick above an exact tick goes up, half below goes down.
    const oneTick = 1 / 1920;
    expect(map.ticksAt(10 * oneTick + oneTick * 0.4)).toBe(10);
    expect(map.ticksAt(10 * oneTick + oneTick * 0.6)).toBe(11);
  });

  it("secondsBetween is the additive difference and may be negative", () => {
    const map = createFixedTempoMap(120);
    expect(map.secondsBetween(0, PPQ * 4)).toBeCloseTo(2, 12);
    expect(map.secondsBetween(PPQ * 4, 0)).toBeCloseTo(-2, 12);
    expect(map.secondsBetween(PPQ, PPQ * 3)).toBeCloseTo(
      map.secondsAt(PPQ * 3) - map.secondsAt(PPQ),
      12,
    );
  });

  it("bpmAt returns the fixed tempo everywhere", () => {
    const map = createFixedTempoMap(140);
    expect(map.bpmAt(0)).toBe(140);
    expect(map.bpmAt(1_000_000)).toBe(140);
  });

  it("exposes ppq === PPQ and the single segment", () => {
    const map = createFixedTempoMap(100);
    expect(map.ppq).toBe(PPQ);
    expect(map.segments).toEqual([{ startTick: 0, bpm: 100 }]);
  });

  it("secondsAt is monotonically increasing", () => {
    const map = createFixedTempoMap(133);
    let prev = -Infinity;
    for (let tick = 0; tick <= PPQ * 16; tick += PPQ / 4) {
      const s = map.secondsAt(tick);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});

describe("createTempoMap with multiple segments", () => {
  // 120bpm for the first 4 quarters (2s), then 60bpm from tick 3840 onward.
  const segments = [
    { startTick: 0, bpm: 120 },
    { startTick: PPQ * 4, bpm: 60 },
  ];

  it("secondsAt(0) === 0", () => {
    const map = createTempoMap(segments);
    expect(map.secondsAt(0)).toBe(0);
  });

  it("matches the single-segment map up to the boundary", () => {
    const map = createTempoMap(segments);
    const fixed120 = createFixedTempoMap(120);
    expect(map.secondsAt(PPQ * 2)).toBeCloseTo(fixed120.secondsAt(PPQ * 2), 12);
    expect(map.secondsAt(PPQ * 4)).toBeCloseTo(fixed120.secondsAt(PPQ * 4), 12);
  });

  it("integrates through the tempo change (piecewise)", () => {
    const map = createTempoMap(segments);
    // First 4 quarters @ 120bpm = 2s exactly.
    const secondsAtBoundary = map.secondsAt(PPQ * 4);
    expect(secondsAtBoundary).toBeCloseTo(2, 12);
    // One more quarter @ 60bpm = 1s more.
    expect(map.secondsAt(PPQ * 5)).toBeCloseTo(3, 12);
  });

  it("bpmAt reflects the active segment on each side of the boundary", () => {
    const map = createTempoMap(segments);
    expect(map.bpmAt(0)).toBe(120);
    expect(map.bpmAt(PPQ * 4 - 1)).toBe(120);
    expect(map.bpmAt(PPQ * 4)).toBe(60);
    expect(map.bpmAt(PPQ * 100)).toBe(60);
  });

  it("ticksAt round-trips across the tempo change", () => {
    const map = createTempoMap(segments);
    for (const tick of [0, 100, PPQ * 4 - 1, PPQ * 4, PPQ * 4 + 1, PPQ * 20]) {
      expect(map.ticksAt(map.secondsAt(tick))).toBe(tick);
    }
  });

  it("handles three or more segments", () => {
    const three = createTempoMap([
      { startTick: 0, bpm: 100 },
      { startTick: PPQ * 2, bpm: 200 },
      { startTick: PPQ * 6, bpm: 50 },
    ]);
    expect(three.bpmAt(0)).toBe(100);
    expect(three.bpmAt(PPQ * 2)).toBe(200);
    expect(three.bpmAt(PPQ * 6)).toBe(50);
    expect(three.bpmAt(PPQ * 1000)).toBe(50);
    // Monotonic across all boundaries.
    let prev = -Infinity;
    for (let t = 0; t <= PPQ * 8; t += 37) {
      const s = three.secondsAt(t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("createTempoMap validation", () => {
  it("throws on empty segments", () => {
    expect(() => createTempoMap([])).toThrow();
  });

  it("throws when the first segment doesn't start at tick 0", () => {
    expect(() => createTempoMap([{ startTick: 10, bpm: 120 }])).toThrow();
  });

  it("throws on non-integer startTick", () => {
    expect(() =>
      createTempoMap([
        { startTick: 0, bpm: 120 },
        { startTick: 100.5, bpm: 90 },
      ]),
    ).toThrow();
  });

  it("throws on unsorted / duplicate startTicks", () => {
    expect(() =>
      createTempoMap([
        { startTick: 0, bpm: 120 },
        { startTick: 100, bpm: 90 },
        { startTick: 100, bpm: 80 },
      ]),
    ).toThrow();
    expect(() =>
      createTempoMap([
        { startTick: 0, bpm: 120 },
        { startTick: 200, bpm: 90 },
        { startTick: 100, bpm: 80 },
      ]),
    ).toThrow();
  });

  it("throws on non-positive bpm", () => {
    expect(() => createTempoMap([{ startTick: 0, bpm: 0 }])).toThrow();
    expect(() => createTempoMap([{ startTick: 0, bpm: -10 }])).toThrow();
  });
});

describe("what actually ships (production build)", () => {
  // The guards in src/time/dev.ts no-op when `import.meta.env.DEV` is false,
  // and Vite statically replaces that with `false` in a production build —
  // so a test suite that only ever runs in dev mode pins nothing about the
  // shipped bundle. Re-importing the module with DEV stubbed off is what
  // separates the checks that are part of `createTempoMap`'s contract from
  // the ones that are a dev-time debugging aid.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("still validates segments with DEV off (the contract on createTempoMap)", async () => {
    vi.stubEnv("DEV", false);
    vi.resetModules();
    const time = await import("./tempoMap");

    // A bpm of 0 does not fail later — it silently yields Infinity/NaN
    // seconds for the whole session — so this one has to throw in every build.
    expect(() => time.createTempoMap([{ startTick: 0, bpm: 0 }])).toThrow();
    expect(() => time.createTempoMap([{ startTick: 0, bpm: Number.NaN }])).toThrow();
    expect(() =>
      time.createTempoMap([
        { startTick: 0, bpm: 120 },
        { startTick: 100.5, bpm: 90 },
      ]),
    ).toThrow();
    expect(() => time.createTempoMap([])).toThrow();
    expect(() => time.createTempoMap([{ startTick: 10, bpm: 120 }])).toThrow();
  });

  it("compiles the per-event integrality guard out with DEV off", async () => {
    // `secondsAt` runs once per scheduled event; its guard is a debugging aid,
    // not a contract, and is deliberately gone from the shipped bundle.
    vi.stubEnv("DEV", false);
    vi.resetModules();
    const time = await import("./tempoMap");
    const map = time.createFixedTempoMap(120);
    expect(() => map.secondsAt(1.5)).not.toThrow();
  });
});

describe("dev-mode integrality guard", () => {
  it("throws when secondsAt is called with a non-integer tick", () => {
    const map = createFixedTempoMap(120);
    expect(() => map.secondsAt(1.5)).toThrow();
  });

  it("throws when bpmAt is called with a non-integer tick", () => {
    const map = createFixedTempoMap(120);
    expect(() => map.bpmAt(0.25)).toThrow();
  });
});
