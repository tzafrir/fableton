// SS18-M1: the transport must play from the DOCUMENT, not from M0's
// hard-coded clip. `clipsForEngine` is the seam — a document snapshot becomes
// exactly the `readonly MidiClip[]` M0's `createClipEventSource` already
// takes, with no change to M0's code and no way for the engine to write back
// (SS3: "the engine never reaches back into the document").

import { describe, expect, it } from "vitest";
import type { NoteEvent } from "../types";
import { createClipEventSource } from "../engine/transport";
import { clipsForEngine } from "./select";
import { BAR, EIGHTH, QUARTER, makeFixture } from "./testing/fixture";

function drain(source: ReturnType<typeof createClipEventSource>, from: number, to: number): NoteEvent[] {
  // The source may yield the SAME mutable object every time (SS12 allocation
  // contract), so copy before advancing.
  const out: NoteEvent[] = [];
  for (const event of source.eventsInRange(from, to)) {
    out.push({ type: event.type, tick: event.tick, trackId: event.trackId, pitch: event.pitch, vel: event.vel });
  }
  return out;
}

describe("playing the document", () => {
  it("turns document clips into scheduler note events", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { start: 0, dur: EIGHTH, pitch: 60, vel: 100 },
        { start: QUARTER, dur: EIGHTH, pitch: 64, vel: 90 },
      ]),
    );

    const source = createClipEventSource(clipsForEngine(f.store.getState()));
    const events = drain(source, 0, BAR);

    expect(events.map((event) => [event.type, event.tick, event.pitch])).toEqual([
      ["noteOn", 0, 60],
      ["noteOff", EIGHTH, 60],
      ["noteOn", QUARTER, 64],
      ["noteOff", QUARTER + EIGHTH, 64],
    ]);
    expect(events[0]?.trackId).toBe(f.trackId);
    expect(events[2]?.vel).toBe(90);
  });

  it("moving a clip moves its events, because clip start is absolute", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ start: 0, dur: EIGHTH, pitch: 60, vel: 100 }]));
    f.store.dispatch(f.commands.moveClips([f.clipId], { ticks: BAR, tracks: 0 }));

    const source = createClipEventSource(clipsForEngine(f.store.getState()));
    expect(drain(source, 0, BAR)).toEqual([]);
    expect(drain(source, BAR, BAR * 2).map((event) => event.tick)).toEqual([BAR, BAR + EIGHTH]);
  });

  it("undo is audible: the source rebuilt from the undone document is silent again", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ start: 0, dur: EIGHTH, pitch: 60, vel: 100 }]));
    expect(drain(createClipEventSource(clipsForEngine(f.store.getState())), 0, BAR)).toHaveLength(2);

    f.store.undo();
    expect(drain(createClipEventSource(clipsForEngine(f.store.getState())), 0, BAR)).toHaveLength(0);
  });

  it("a clip loop unrolls, and the clip's notes stay clip-relative", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ start: 0, dur: EIGHTH, pitch: 60, vel: 100 }]));
    f.store.dispatch(f.commands.setClipLoop(f.clipId, { start: 0, end: QUARTER }));

    const source = createClipEventSource(clipsForEngine(f.store.getState()));
    const onsets = drain(source, 0, BAR)
      .filter((event) => event.type === "noteOn")
      .map((event) => event.tick);
    expect(onsets).toEqual([0, QUARTER, QUARTER * 2, QUARTER * 3]);
  });
});
