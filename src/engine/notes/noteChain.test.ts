// The note chain: assembly, and the two pumps that drive it.

import { describe, expect, it } from "vitest";
import type { DeviceInstance, NoteTarget, NoteWindow, TempoMap } from "../../types";
import { PPQ } from "../../types";
import { createTempoMap } from "../../time";
import {
  buildNoteChain,
  createNoteChainRunner,
  noteTargetOfInstance,
  FREE_LOOKAHEAD_SECONDS,
} from "./noteChain";

interface Log {
  readonly entries: string[];
  readonly target: NoteTarget;
}

function recorder(name: string): Log {
  const entries: string[] = [];
  return {
    entries,
    target: {
      noteOn: (pitch, vel, when) => entries.push(`${name}:on ${pitch} ${vel} @${when}`),
      noteOff: (pitch, when) => entries.push(`${name}:off ${pitch} @${when}`),
      allNotesOff: (when) => entries.push(`${name}:panic @${when}`),
    },
  };
}

/** A note effect that transposes what it is given and counts its pumps. */
function transposer(by: number): DeviceInstance & { windows: NoteWindow[] } {
  let out: NoteTarget | null = null;
  const windows: NoteWindow[] = [];
  return {
    windows,
    connectParam: () => undefined,
    noteOn: (pitch, vel, when) => out?.noteOn(pitch + by, vel, when),
    noteOff: (pitch, when) => out?.noteOff(pitch + by, when),
    allNotesOff: (when) => out?.allNotesOff(when),
    setNoteOutput: (target) => {
      out = target;
    },
    fillNotes: (window) => {
      // Snapshot: the runner reuses one window object, so retaining it would
      // be retaining whatever the NEXT window says.
      windows.push({
        fromTick: window.fromTick,
        toTick: window.toTick,
        ppq: window.ppq,
        timeAt: window.timeAt,
      });
    },
    dispose: () => undefined,
  };
}

/** A device that takes no notes at all — a pure generator. */
function generator(): DeviceInstance & { out: NoteTarget | null } {
  const device = {
    out: null as NoteTarget | null,
    connectParam: () => undefined,
    setNoteOutput: (target: NoteTarget) => {
      device.out = target;
    },
    dispose: () => undefined,
  };
  return device;
}

function fakeContext(now = 0): BaseAudioContext & { now: number } {
  const ctx = {
    now,
    get currentTime(): number {
      return ctx.now;
    },
  };
  return ctx as unknown as BaseAudioContext & { now: number };
}

const map120: TempoMap = createTempoMap([{ startTick: 0, bpm: 120 }]);

describe("buildNoteChain", () => {
  it("routes notes through every effect, in order, into the instrument", () => {
    const instrument = recorder("inst");
    const chain = buildNoteChain("t1", [transposer(12), transposer(1)], instrument.target);
    chain.head.noteOn(60, 100, 0);
    expect(instrument.entries).toEqual(["inst:on 73 100 @0"]);
  });

  it("hands an EMPTY chain straight to the instrument", () => {
    const instrument = recorder("inst");
    const chain = buildNoteChain("t1", [], instrument.target);
    expect(chain.head).toBe(instrument.target);
  });

  it("routes past a device that takes no notes, but still gives it an output", () => {
    const instrument = recorder("inst");
    const gen = generator();
    const chain = buildNoteChain("t1", [gen], instrument.target);
    // Nothing to receive on, so the head is the instrument itself...
    expect(chain.head).toBe(instrument.target);
    // ...but the generator can still push notes at it.
    gen.out?.noteOn(64, 90, 1);
    expect(instrument.entries).toEqual(["inst:on 64 90 @1"]);
  });
});

describe("noteTargetOfInstance", () => {
  it("is undefined for a device with no noteOn", () => {
    expect(noteTargetOfInstance(generator())).toBeUndefined();
  });

  it("fills in the two optional halves, so a percussion effect is still usable", () => {
    const seen: string[] = [];
    const instance = {
      connectParam: () => undefined,
      noteOn: (pitch: number) => seen.push(`on ${pitch}`),
      dispose: () => undefined,
    } as unknown as DeviceInstance;
    const target = noteTargetOfInstance(instance)!;
    expect(() => {
      target.noteOff(60, 0);
      target.allNotesOff(0);
    }).not.toThrow();
    target.noteOn(60, 100, 0);
    expect(seen).toEqual(["on 60"]);
  });
});

describe("the transport pump", () => {
  it("does nothing at all when no channel has an effect", () => {
    const runner = createNoteChainRunner({ ctx: fakeContext(), tempoMap: () => map120 });
    expect(runner.hasEffects()).toBe(false);
    expect(() => runner.fillWindow(1, 0, PPQ)).not.toThrow();
  });

  it("hands each effect the window, in chain order", () => {
    const a = transposer(0);
    const b = transposer(0);
    const runner = createNoteChainRunner({ ctx: fakeContext(), tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [a, b], recorder("i").target)]);
    runner.fillWindow(0.5, 0, PPQ);
    expect(a.windows).toHaveLength(1);
    expect(b.windows).toHaveLength(1);
    expect(a.windows[0]!.fromTick).toBe(0);
    expect(a.windows[0]!.toTick).toBe(PPQ);
    expect(a.windows[0]!.ppq).toBe(PPQ);
  });

  it("maps ticks to the same seconds the transport would", () => {
    const effect = transposer(0);
    const runner = createNoteChainRunner({ ctx: fakeContext(), tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [effect], recorder("i").target)]);
    // A window ending at tick PPQ (one beat) whose end sounds at t = 2.0.
    runner.fillWindow(2, 0, PPQ);
    const window = effect.windows[0]!;
    expect(window.timeAt(PPQ)).toBeCloseTo(2, 9);
    // One beat at 120 bpm is half a second earlier.
    expect(window.timeAt(0)).toBeCloseTo(1.5, 9);
    expect(window.timeAt(PPQ / 2)).toBeCloseTo(1.75, 9);
  });
});

describe("the free-running pump", () => {
  it("stays out of the way while the transport is playing", () => {
    const effect = transposer(0);
    const ctx = fakeContext(10);
    const runner = createNoteChainRunner({ ctx, tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [effect], recorder("i").target)]);
    runner.setPlaying(true);
    runner.pumpFree();
    expect(effect.windows).toHaveLength(0);
  });

  it("advances a contiguous tick line from the wall clock", () => {
    const effect = transposer(0);
    const ctx = fakeContext(10);
    const runner = createNoteChainRunner({ ctx, tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [effect], recorder("i").target)]);

    runner.pumpFree();
    ctx.now += FREE_LOOKAHEAD_SECONDS;
    runner.pumpFree();

    expect(effect.windows).toHaveLength(2);
    // No gap and no overlap: the second window opens exactly where the first
    // one closed, which is what keeps an arpeggiator's grid even.
    expect(effect.windows[1]!.fromTick).toBe(effect.windows[0]!.toTick);
    // And its notes still carry future timestamps.
    expect(effect.windows[1]!.timeAt(effect.windows[1]!.fromTick)).toBeGreaterThan(ctx.now);
  });

  it("covers a window of about the look-ahead, in ticks at the current tempo", () => {
    const effect = transposer(0);
    const ctx = fakeContext(4);
    const runner = createNoteChainRunner({ ctx, tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [effect], recorder("i").target)]);
    runner.pumpFree();
    const window = effect.windows[0]!;
    const beats = (window.toTick - window.fromTick) / PPQ;
    // 80 ms at 120 bpm is a shade under a sixth of a beat.
    expect(beats * 0.5).toBeGreaterThan(0);
    expect(beats * 0.5).toBeLessThanOrEqual(FREE_LOOKAHEAD_SECONDS + 1e-9);
  });

  it("re-anchors instead of scheduling the backlog after a stall", () => {
    const effect = transposer(0);
    const ctx = fakeContext(1);
    const runner = createNoteChainRunner({ ctx, tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [effect], recorder("i").target)]);
    runner.pumpFree();
    // The tab went away for ten seconds.
    ctx.now += 10;
    runner.pumpFree();
    const window = effect.windows[1]!;
    const span = window.toTick - window.fromTick;
    // One look-ahead of material, not ten seconds of it.
    expect(span / PPQ / 2).toBeLessThanOrEqual(FREE_LOOKAHEAD_SECONDS + 1e-9);
    expect(window.timeAt(window.fromTick)).toBeGreaterThanOrEqual(ctx.now);
  });

  it("re-anchors when the transport takes over and gives it back", () => {
    const effect = transposer(0);
    const ctx = fakeContext(1);
    const runner = createNoteChainRunner({ ctx, tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [effect], recorder("i").target)]);
    runner.pumpFree();
    const before = effect.windows[0]!.toTick;
    runner.setPlaying(true);
    runner.setPlaying(false);
    ctx.now += 1;
    runner.pumpFree();
    // A fresh tick line, not a continuation of one a second of playback ago.
    expect(effect.windows[1]!.fromTick).toBeLessThan(before);
  });

  it("releases every chain on releaseAll", () => {
    const instrument = recorder("inst");
    const runner = createNoteChainRunner({ ctx: fakeContext(), tempoMap: () => map120 });
    runner.setChains([buildNoteChain("t1", [transposer(0)], instrument.target)]);
    runner.releaseAll(3);
    expect(instrument.entries).toEqual(["inst:panic @3"]);
  });
});
