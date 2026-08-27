import { describe, expect, it } from "vitest";
import type { TimeSignature } from "../types";
import { PPQ, TICKS_PER_WHOLE_NOTE } from "../types";
import {
  barBeatTickToTick,
  formatBarBeatTick,
  snapTicks,
  tickToBarBeatTick,
  ticksPerBar,
  ticksPerBeat,
  ticksPerNote,
} from "./grid";

const fourFour: TimeSignature = { numerator: 4, denominator: 4 };

describe("ticksPerNote", () => {
  it("a 1/16 note is exactly 240 ticks at 960 PPQ (SS8 worked example)", () => {
    expect(ticksPerNote(16)).toBe(240);
  });

  it("a quarter note is exactly PPQ", () => {
    expect(ticksPerNote(4)).toBe(PPQ);
  });

  it("a whole note is TICKS_PER_WHOLE_NOTE", () => {
    expect(ticksPerNote(1)).toBe(TICKS_PER_WHOLE_NOTE);
  });

  it("an eighth note is 480 ticks", () => {
    expect(ticksPerNote(8)).toBe(480);
  });

  it("a 1/128 note (piano-roll resize floor, SS10) is 30 ticks", () => {
    expect(ticksPerNote(128)).toBe(30);
  });

  it("triplet subdivision is 2/3 of the straight duration", () => {
    // An eighth-note triplet: 3 in the space of 2 eighths = 1 quarter (960).
    expect(ticksPerNote(8, true)).toBe(320);
    expect(ticksPerNote(8, true) * 3).toBe(ticksPerNote(4));
  });

  it("throws when the subdivision doesn't divide evenly into integer ticks", () => {
    expect(() => ticksPerNote(7)).toThrow();
  });
});

describe("ticksPerBeat / ticksPerBar", () => {
  it("4/4: one beat is a quarter, one bar is 4 quarters", () => {
    expect(ticksPerBeat(fourFour)).toBe(PPQ);
    expect(ticksPerBar(fourFour)).toBe(PPQ * 4);
  });

  it("3/4: bar is 3 quarters", () => {
    expect(ticksPerBar({ numerator: 3, denominator: 4 })).toBe(PPQ * 3);
  });

  it("6/8: beat is an eighth, bar is 6 eighths", () => {
    const sig: TimeSignature = { numerator: 6, denominator: 8 };
    expect(ticksPerBeat(sig)).toBe(480);
    expect(ticksPerBar(sig)).toBe(480 * 6);
  });
});

describe("tickToBarBeatTick / barBeatTickToTick", () => {
  it("tick 0 is bar 1, beat 1, tick 0", () => {
    expect(tickToBarBeatTick(0, fourFour)).toEqual({ bar: 1, beat: 1, tick: 0 });
  });

  it("one bar in is bar 2 beat 1", () => {
    expect(tickToBarBeatTick(PPQ * 4, fourFour)).toEqual({
      bar: 2,
      beat: 1,
      tick: 0,
    });
  });

  it("mid-beat position decomposes correctly", () => {
    // bar 1, beat 3 (2 quarters in), + 100 ticks into that beat.
    const tick = PPQ * 2 + 100;
    expect(tickToBarBeatTick(tick, fourFour)).toEqual({
      bar: 1,
      beat: 3,
      tick: 100,
    });
  });

  it("round-trips through barBeatTickToTick", () => {
    for (const tick of [0, 1, 239, 240, 3839, 3840, 3841, 100000, 123457]) {
      const bbt = tickToBarBeatTick(tick, fourFour);
      expect(barBeatTickToTick(bbt, fourFour)).toBe(tick);
    }
  });

  it("handles a non-4/4 signature (3/4)", () => {
    const sig: TimeSignature = { numerator: 3, denominator: 4 };
    // Bar is 3 quarters = 2880 ticks; tick 2880 is bar 2 beat 1.
    expect(tickToBarBeatTick(PPQ * 3, sig)).toEqual({ bar: 2, beat: 1, tick: 0 });
  });
});

describe("formatBarBeatTick", () => {
  it("formats with zero-padded tick", () => {
    expect(formatBarBeatTick({ bar: 1, beat: 1, tick: 0 })).toBe("1.1.000");
    expect(formatBarBeatTick({ bar: 12, beat: 3, tick: 7 })).toBe("12.3.007");
    expect(formatBarBeatTick({ bar: 1, beat: 1, tick: 240 })).toBe("1.1.240");
  });
});

describe("snapTicks", () => {
  const grid = 240; // 1/16 note

  it("snaps to nearest by default", () => {
    expect(snapTicks(0, grid)).toBe(0);
    expect(snapTicks(100, grid)).toBe(0);
    expect(snapTicks(140, grid)).toBe(240);
    expect(snapTicks(120, grid)).toBe(240); // ties round up like Math.round
  });

  it("floor mode always rounds down to the grid", () => {
    expect(snapTicks(239, grid, "floor")).toBe(0);
    expect(snapTicks(240, grid, "floor")).toBe(240);
    expect(snapTicks(479, grid, "floor")).toBe(240);
  });

  it("ceil mode always rounds up to the grid", () => {
    expect(snapTicks(1, grid, "ceil")).toBe(240);
    expect(snapTicks(240, grid, "ceil")).toBe(240);
    expect(snapTicks(241, grid, "ceil")).toBe(480);
  });

  it("is a no-op on values already on the grid", () => {
    for (const tick of [0, 240, 480, 720, 960 * 4]) {
      expect(snapTicks(tick, grid)).toBe(tick);
    }
  });

  it("handles negative ticks symmetrically", () => {
    expect(snapTicks(-100, grid)).toBe(0);
    expect(snapTicks(-140, grid)).toBe(-240);
    expect(snapTicks(-239, grid, "floor")).toBe(-240);
    expect(snapTicks(-241, grid, "ceil")).toBe(-240);
  });
});

describe("dev-mode integrality guards", () => {
  it("tickToBarBeatTick throws on a fractional tick", () => {
    expect(() => tickToBarBeatTick(1.5, fourFour)).toThrow();
  });

  it("snapTicks throws on a fractional tick", () => {
    expect(() => snapTicks(1.5, 240)).toThrow();
  });

  it("snapTicks throws on a fractional grid", () => {
    expect(() => snapTicks(240, 100.5)).toThrow();
  });
});
