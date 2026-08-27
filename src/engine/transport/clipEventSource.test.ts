import { describe, expect, it } from "vitest";
import type { MidiClip, Note, NoteEvent, Ticks } from "../../types";
import { PPQ } from "../../types";
import { createClipEventSource } from "./clipEventSource";

const SIXTEENTH = PPQ / 4; // 240
const BEAT = PPQ; // 960

/** Plain copy of an event — the source reuses one mutable object. */
interface Snapshot {
  type: string;
  tick: Ticks;
  trackId: string;
  pitch: number;
  vel: number;
}

function snap(ev: NoteEvent): Snapshot {
  return {
    type: ev.type,
    tick: ev.tick,
    trackId: ev.trackId,
    pitch: ev.pitch,
    vel: ev.vel,
  };
}

function collect(events: Iterable<NoteEvent>): Snapshot[] {
  const out: Snapshot[] = [];
  for (const ev of events) out.push(snap(ev));
  return out;
}

/** Compact `"noteOn@960:60"` form, for readable expectations. */
function brief(events: Iterable<NoteEvent>): string[] {
  return collect(events).map(
    (e) => `${e.type === "noteOn" ? "on" : "off"}@${String(e.tick)}:${String(e.pitch)}`,
  );
}

let nextNoteId = 0;
function note(start: Ticks, dur: Ticks, pitch: number, vel = 100): Note {
  nextNoteId++;
  return { id: `n${String(nextNoteId)}`, start, dur, pitch, vel };
}

function clip(partial: Partial<MidiClip> & { notes: Note[] }): MidiClip {
  return {
    id: partial.id ?? "c1",
    trackId: partial.trackId ?? "track-1",
    start: partial.start ?? 0,
    length: partial.length ?? 4 * BEAT,
    ...(partial.loop === undefined ? {} : { loop: partial.loop }),
    notes: partial.notes,
  };
}

describe("createClipEventSource — flat clips", () => {
  it("yields note-on/off pairs in tick order", () => {
    const source = createClipEventSource([
      clip({ notes: [note(0, SIXTEENTH, 60), note(BEAT, SIXTEENTH, 64, 90)] }),
    ]);
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@0:60",
      "off@240:60",
      "on@960:64",
      "off@1200:64",
    ]);
  });

  it("carries velocity on note-on and track id on both", () => {
    const source = createClipEventSource([
      clip({ trackId: "lead", notes: [note(0, SIXTEENTH, 60, 77)] }),
    ]);
    const [on, off] = collect(source.eventsInRange(0, BEAT));
    expect(on).toEqual({
      type: "noteOn",
      tick: 0,
      trackId: "lead",
      pitch: 60,
      vel: 77,
    });
    expect(off?.type).toBe("noteOff");
    expect(off?.trackId).toBe("lead");
  });

  it("is half-open: [from, to) includes from and excludes to", () => {
    const source = createClipEventSource([
      clip({ notes: [note(0, SIXTEENTH, 60), note(SIXTEENTH, SIXTEENTH, 61)] }),
    ]);
    expect(brief(source.eventsInRange(0, SIXTEENTH))).toEqual(["on@0:60"]);
    expect(brief(source.eventsInRange(SIXTEENTH, 2 * SIXTEENTH))).toEqual([
      "off@240:60",
      "on@240:61",
    ]);
  });

  it("releases a pitch before retriggering it at the same tick", () => {
    const source = createClipEventSource([
      clip({ notes: [note(0, SIXTEENTH, 60), note(SIXTEENTH, SIXTEENTH, 60)] }),
    ]);
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@0:60",
      "off@240:60",
      "on@240:60",
      "off@480:60",
    ]);
  });

  it("offsets everything by the clip's position on the timeline", () => {
    const source = createClipEventSource([
      clip({ start: 4 * BEAT, notes: [note(0, SIXTEENTH, 60)] }),
    ]);
    expect(brief(source.eventsInRange(0, 16 * BEAT))).toEqual([
      "on@3840:60",
      "off@4080:60",
    ]);
  });

  it("cuts a note that overhangs the clip end", () => {
    const source = createClipEventSource([
      clip({ length: BEAT, notes: [note(0, 10 * BEAT, 60)] }),
    ]);
    expect(brief(source.eventsInRange(0, 16 * BEAT))).toEqual([
      "on@0:60",
      "off@960:60",
    ]);
  });

  it("skips muted notes and zero-length junk", () => {
    const muted: Note = { ...note(0, SIXTEENTH, 60), muted: true };
    const zero: Note = { ...note(0, 0, 61) };
    const source = createClipEventSource([
      clip({ notes: [muted, zero, note(BEAT, SIXTEENTH, 62)] }),
    ]);
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@960:62",
      "off@1200:62",
    ]);
  });

  it("reports endTick as the end of the last clip", () => {
    const source = createClipEventSource([
      clip({ id: "a", start: 0, length: 2 * BEAT, notes: [] }),
      clip({ id: "b", start: 8 * BEAT, length: 4 * BEAT, notes: [] }),
    ]);
    expect(source.endTick()).toBe(12 * BEAT);
    expect(createClipEventSource([]).endTick()).toBe(0);
  });
});

describe("createClipEventSource — clip loops", () => {
  it("tiles the loop region across the clip length", () => {
    const source = createClipEventSource([
      clip({
        length: 4 * BEAT,
        loop: { start: 0, end: BEAT },
        notes: [note(0, SIXTEENTH, 60)],
      }),
    ]);
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@0:60",
      "off@240:60",
      "on@960:60",
      "off@1200:60",
      "on@1920:60",
      "off@2160:60",
      "on@2880:60",
      "off@3120:60",
    ]);
  });

  it("plays material before loop.start once, then repeats the region", () => {
    const source = createClipEventSource([
      clip({
        length: 2400,
        loop: { start: 480, end: 960 },
        notes: [note(0, SIXTEENTH, 60), note(480, SIXTEENTH, 67)],
      }),
    ]);
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@0:60",
      "off@240:60",
      "on@480:67",
      "off@720:67",
      "on@960:67",
      "off@1200:67",
      "on@1440:67",
      "off@1680:67",
      "on@1920:67",
      "off@2160:67",
    ]);
  });

  it("cuts a note at the loop boundary instead of ringing across it", () => {
    const source = createClipEventSource([
      clip({
        length: 2 * BEAT,
        loop: { start: 0, end: BEAT },
        notes: [note(900, 240, 60)],
      }),
    ]);
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@900:60",
      "off@960:60",
      "on@1860:60",
      "off@1920:60",
    ]);
  });

  it("stops the last repetition at the clip length", () => {
    const source = createClipEventSource([
      clip({
        length: 1500,
        loop: { start: 0, end: BEAT },
        notes: [note(600, SIXTEENTH, 60)],
      }),
    ]);
    // Second repetition covers rel [960, 1500): the note at 600 lands at 1560,
    // past the clip end, so it never sounds again.
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@600:60",
      "off@840:60",
    ]);
  });

  it("ignores a degenerate brace", () => {
    const source = createClipEventSource([
      clip({
        length: 2 * BEAT,
        loop: { start: 480, end: 480 },
        notes: [note(0, SIXTEENTH, 60)],
      }),
    ]);
    expect(brief(source.eventsInRange(0, 4 * BEAT))).toEqual([
      "on@0:60",
      "off@240:60",
    ]);
  });
});

describe("createClipEventSource — multiple clips", () => {
  it("merges clips on different tracks into one non-decreasing stream", () => {
    const source = createClipEventSource([
      clip({ id: "a", trackId: "drums", notes: [note(0, 120, 36), note(BEAT, 120, 38)] }),
      clip({ id: "b", trackId: "bass", start: 480, notes: [note(0, 120, 48)] }),
    ]);
    const all = collect(source.eventsInRange(0, 4 * BEAT));
    expect(all.map((e) => e.tick)).toEqual([0, 120, 480, 600, 960, 1080]);
    expect(all.map((e) => e.trackId)).toEqual([
      "drums",
      "drums",
      "bass",
      "bass",
      "drums",
      "drums",
    ]);
  });
});

describe("createClipEventSource — scheduler contract", () => {
  const source = () =>
    createClipEventSource([
      clip({
        id: "a",
        length: 4 * BEAT,
        loop: { start: 0, end: 3 * SIXTEENTH },
        notes: [note(0, 100, 60), note(120, 300, 67)],
      }),
      clip({
        id: "b",
        trackId: "t2",
        start: 300,
        length: 5 * BEAT,
        notes: [note(0, 700, 40), note(1000, 200, 41)],
      }),
    ]);

  it("splitting a range into contiguous windows yields the same stream", () => {
    const whole = collect(source().eventsInRange(0, 10 * BEAT));
    for (const width of [1, 7, 240, 383, 960]) {
      const parts: Snapshot[] = [];
      const src = source();
      for (let t = 0; t < 10 * BEAT; t += width) {
        for (const ev of src.eventsInRange(t, Math.min(t + width, 10 * BEAT))) {
          parts.push(snap(ev));
        }
      }
      expect(parts, `window width ${String(width)}`).toEqual(whole);
    }
  });

  it("yields non-decreasing ticks", () => {
    let prev = -Infinity;
    for (const ev of source().eventsInRange(0, 10 * BEAT)) {
      expect(ev.tick).toBeGreaterThanOrEqual(prev);
      prev = ev.tick;
    }
  });

  it("reuses one event object (SS12 allocation contract)", () => {
    const seen: NoteEvent[] = [];
    for (const ev of source().eventsInRange(0, 10 * BEAT)) seen.push(ev);
    expect(seen.length).toBeGreaterThan(4);
    for (const ev of seen) expect(ev).toBe(seen[0]);
  });

  it("emits no note-off for a note whose note-on this pass skipped over", () => {
    // A window that does NOT continue the previous one — the transport's loop
    // brace, a seek, `play(fromTick)` — lands mid-note. That note's note-on
    // was never emitted on this pass, so its note-off must not be either: the
    // `NoteTarget` contract is on/off pairs, and an instrument that voices
    // overlapping same-pitch notes separately would cut a live voice.
    const src = createClipEventSource([
      clip({
        length: 4 * BEAT,
        notes: [note(0, 2 * BEAT, 60), note(BEAT, 100, 62), note(2 * BEAT, 240, 64)],
      }),
    ]);
    // Jump into the middle of the 2-beat note at pitch 60 (and past the whole
    // of the note at 62). Neither of their note-offs may be emitted here —
    // only the note that actually starts inside this window is a pair.
    expect(brief(src.eventsInRange(BEAT + 50, 3 * BEAT))).toEqual([
      "on@1920:64",
      "off@2160:64",
    ]);
  });

  it("emits no orphan note-offs across a transport loop brace", () => {
    // The brace is unrolled by the transport as window [x, braceEnd) then
    // window [braceStart, ...), which is exactly the discontinuity above, once
    // per pass. With a brace that does not start at 0, notes that began before
    // it are precisely the ones whose note-offs would land orphaned.
    const braceStart = BEAT;
    const braceEnd = 3 * BEAT;
    const src = createClipEventSource([
      clip({
        length: 8 * BEAT,
        notes: [
          note(0, 2 * BEAT + 300, 60), // starts before the brace, ends inside it
          note(BEAT + 100, 300, 62),
          note(2 * BEAT + 500, 2 * BEAT, 64), // straddles the brace end
        ],
      }),
    ]);
    const held = new Map<number, number>();
    let orphans = 0;
    for (let pass = 0; pass < 8; pass++) {
      const from0 = pass === 0 ? 0 : braceStart;
      for (let from = from0; from < braceEnd; from += 137) {
        const to = Math.min(from + 137, braceEnd);
        for (const ev of src.eventsInRange(from, to)) {
          if (ev.type === "noteOn") held.set(ev.pitch, (held.get(ev.pitch) ?? 0) + 1);
          else {
            const n = held.get(ev.pitch) ?? 0;
            if (n === 0) orphans++;
            else held.set(ev.pitch, n - 1);
          }
        }
      }
      held.clear(); // the transport cuts whatever is still held at the brace
    }
    expect(orphans).toBe(0);
  });

  it("keeps orphan suppression alive across a window split on a clip-loop boundary", () => {
    // Regression: the window boundary a look-ahead pass happens to fall on is
    // decided by the wall clock, so it must never change WHICH events come
    // out. After a jump (brace wrap / seek / `play(fromTick)`) the note-offs
    // of notes whose note-on this pass skipped are suppressed; backing up over
    // a clip-loop repetition boundary at the start of the next window used to
    // retire that suppression and resurrect the note-off — unpaired, and, at
    // the transport level, able to release a genuinely live voice of the same
    // pitch on the track.
    const make = (): ReturnType<typeof createClipEventSource> =>
      createClipEventSource([
        clip({
          length: 2000,
          loop: { start: 100, end: 800 },
          notes: [note(0, 5000, 61), note(600, 100, 60)],
        }),
      ]);

    const whole = make();
    const oneWindow = brief(whole.eventsInRange(500, 1000));
    expect(oneWindow).toEqual(["on@600:60", "off@700:60"]);

    // Same range, split exactly on the repetition boundary (rel 800).
    const split = make();
    const parts = [
      ...brief(split.eventsInRange(500, 800)),
      ...brief(split.eventsInRange(800, 1000)),
    ];
    expect(parts).toEqual(oneWindow);
  });

  it("matches the unsplit stream for every window boundary after a jump", () => {
    // Differential over every split point of the same post-jump range: no
    // partition may add or drop an event.
    const make = (): ReturnType<typeof createClipEventSource> =>
      createClipEventSource([
        clip({
          length: 4000,
          loop: { start: 100, end: 800 },
          notes: [note(0, 5000, 61), note(600, 100, 60), note(150, 900, 62)],
        }),
      ]);
    const from = 500;
    const to = 2600;
    const whole = brief(make().eventsInRange(from, to));
    for (let cut = from + 1; cut < to; cut++) {
      const src = make();
      const parts = [
        ...brief(src.eventsInRange(from, cut)),
        ...brief(src.eventsInRange(cut, to)),
      ];
      expect(parts, `split at ${String(cut)}`).toEqual(whole);
    }
  });

  it("survives being re-queried for an earlier window (seek backwards)", () => {
    const src = source();
    const first = brief(src.eventsInRange(0, BEAT));
    void collect(src.eventsInRange(8 * BEAT, 9 * BEAT));
    expect(brief(src.eventsInRange(0, BEAT))).toEqual(first);
  });
});
