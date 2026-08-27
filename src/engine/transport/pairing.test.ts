// A stuck note is always the same shape: a note-on with no note-off. This is
// that property, checked over the clip scanner directly and over randomly
// chopped look-ahead windows — because the scanner's hard cases are all about
// where a window boundary falls (a repetition edge, a clip end, a note that
// straddles either).

import { describe, expect, it } from "vitest";
import type { MidiClip } from "../../types";
import { PPQ } from "../../types";
import { createClipEventSource } from "./clipEventSource";

const BAR = 4 * PPQ;

/** Deterministic PRNG — a failing seed is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Plays `clips` from 0 to `end` in windows of random size and returns the
 *  pitches left sounding — the stuck notes. */
function unpaired(clips: readonly MidiClip[], end: number, random: () => number): string[] {
  const source = createClipEventSource(clips);
  const held = new Map<string, number>();
  let from = 0;
  while (from < end) {
    const to = Math.min(end, from + 1 + Math.floor(random() * BAR));
    for (const event of source.eventsInRange(from, to)) {
      const key = `${event.trackId}:${String(event.pitch)}`;
      const count = held.get(key) ?? 0;
      if (event.type === "noteOn") held.set(key, count + 1);
      else if (count > 0) held.set(key, count - 1);
    }
    from = to;
  }
  return [...held.entries()].filter(([, count]) => count > 0).map(([key]) => key);
}

function clipOf(notes: MidiClip["notes"], extra: Partial<MidiClip> = {}): MidiClip {
  return { id: "c1", trackId: "t1", start: 0, length: BAR, notes, ...extra };
}

describe("every note that starts also stops", () => {
  it("holds for a note ending exactly at the clip end", () => {
    const clip = clipOf([{ id: "n1", start: BAR - 480, dur: 480, pitch: 60, vel: 100 }]);
    expect(unpaired([clip], BAR * 2, rng(1))).toEqual([]);
  });

  it("holds for a note running PAST the clip end (it is cut at the end)", () => {
    const clip = clipOf([{ id: "n1", start: BAR - 240, dur: BAR, pitch: 60, vel: 100 }]);
    expect(unpaired([clip], BAR * 3, rng(2))).toEqual([]);
  });

  it("holds for a looped clip, at every repetition boundary", () => {
    const clip = clipOf(
      [
        { id: "n1", start: 0, dur: 960, pitch: 60, vel: 100 },
        { id: "n2", start: 900, dur: 900, pitch: 67, vel: 100 },
      ],
      { length: BAR * 4, loop: { start: 0, end: BAR } },
    );
    expect(unpaired([clip], BAR * 5, rng(3))).toEqual([]);
  });

  it("holds for a clip whose loop has an intro before loop.start", () => {
    const clip = clipOf(
      [
        { id: "n1", start: 0, dur: 480, pitch: 48, vel: 100 },
        { id: "n2", start: BAR, dur: 700, pitch: 55, vel: 100 },
      ],
      { length: BAR * 4, loop: { start: BAR, end: BAR * 2 } },
    );
    expect(unpaired([clip], BAR * 5, rng(4))).toEqual([]);
  });

  it("holds across 200 random clip/window combinations", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = rng(seed * 7919);
      const noteCount = 1 + Math.floor(random() * 6);
      const length = BAR * (1 + Math.floor(random() * 3));
      const notes: MidiClip["notes"] = [];
      for (let i = 0; i < noteCount; i += 1) {
        notes.push({
          id: `n${String(i)}`,
          start: Math.floor(random() * length),
          // Durations deliberately reach past the clip end: a note cut by the
          // end of its clip is the case a scanner is most likely to drop.
          dur: 1 + Math.floor(random() * BAR),
          pitch: 40 + Math.floor(random() * 24),
          vel: 100,
        });
      }
      notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      const looped = random() < 0.5;
      const loopEnd = Math.max(1, Math.floor(random() * length));
      const clip = clipOf(notes, {
        length,
        start: Math.floor(random() * BAR),
        ...(looped ? { loop: { start: 0, end: loopEnd } } : {}),
      });
      const stuck = unpaired([clip], BAR * 6, random);
      expect(stuck, `seed ${String(seed)} left ${stuck.join(",")} sounding`).toEqual([]);
    }
  });
});
