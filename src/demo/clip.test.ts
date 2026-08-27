import { describe, expect, it } from "vitest";
import type { NoteEventType } from "../types";
import { createClipEventSource } from "../engine/transport";
import { DEMO_CLIP, DEMO_TRACK_ID } from "./clip";

describe("DEMO_CLIP (SS18-M0 hard-coded clip)", () => {
  it("is well-formed at PPQ=960: integer ticks, notes within [0, length)", () => {
    expect(DEMO_CLIP.trackId).toBe(DEMO_TRACK_ID);
    expect(Number.isInteger(DEMO_CLIP.length)).toBe(true);
    expect(DEMO_CLIP.length).toBeGreaterThan(0);
    expect(DEMO_CLIP.notes.length).toBeGreaterThan(0);

    for (const note of DEMO_CLIP.notes) {
      expect(Number.isInteger(note.start)).toBe(true);
      expect(Number.isInteger(note.dur)).toBe(true);
      expect(note.dur).toBeGreaterThanOrEqual(1);
      expect(note.start).toBeGreaterThanOrEqual(0);
      expect(note.start + note.dur).toBeLessThanOrEqual(DEMO_CLIP.length);
      expect(note.pitch).toBeGreaterThanOrEqual(0);
      expect(note.pitch).toBeLessThanOrEqual(127);
      expect(note.vel).toBeGreaterThanOrEqual(1);
      expect(note.vel).toBeLessThanOrEqual(127);
    }

    expect(new Set(DEMO_CLIP.notes.map((n) => n.id)).size).toBe(DEMO_CLIP.notes.length);
  });

  it("produces a non-decreasing noteOn/noteOff stream covering every note", () => {
    const source = createClipEventSource([DEMO_CLIP]);

    // NoteEvent's allocation contract (SS12) permits the SAME mutable object
    // to be yielded every iteration — copy the fields out before advancing,
    // never retain the yielded value itself.
    const events: { type: NoteEventType; tick: number; trackId: string; pitch: number }[] = [];
    for (const ev of source.eventsInRange(0, DEMO_CLIP.length + 1)) {
      events.push({ type: ev.type, tick: ev.tick, trackId: ev.trackId, pitch: ev.pitch });
    }

    expect(events).toHaveLength(DEMO_CLIP.notes.length * 2); // one on + one off per note

    let lastTick = -Infinity;
    for (const ev of events) {
      expect(ev.tick).toBeGreaterThanOrEqual(lastTick);
      lastTick = ev.tick;
      expect(ev.trackId).toBe(DEMO_TRACK_ID);
    }

    const onCount = events.filter((e) => e.type === "noteOn").length;
    const offCount = events.filter((e) => e.type === "noteOff").length;
    expect(onCount).toBe(DEMO_CLIP.notes.length);
    expect(offCount).toBe(DEMO_CLIP.notes.length);

    // Every noteOn's pitch is one this clip actually declares.
    const declaredPitches = new Set(DEMO_CLIP.notes.map((n) => n.pitch));
    for (const ev of events) {
      if (ev.type === "noteOn") expect(declaredPitches.has(ev.pitch)).toBe(true);
    }
  });
});
