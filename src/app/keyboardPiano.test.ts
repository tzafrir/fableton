// The QWERTY keyboard as a MIDI keyboard, and the recorder it feeds.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OCTAVE,
  MAX_OCTAVE,
  MIN_OCTAVE,
  createKeyboardPiano,
  pitchForKey,
} from "./keyboardPiano";
import { MIN_RECORDED_DUR_TICKS, createNoteRecorder } from "./noteRecorder";

function rig(octave = DEFAULT_OCTAVE) {
  const sink = { noteOn: vi.fn(), noteOff: vi.fn() };
  const piano = createKeyboardPiano({ sink: () => sink, octave });
  return { piano, sink };
}

describe("the key layout", () => {
  it("puts the white keys on the home row, C first", () => {
    const row = ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";"];
    expect(row.map((key) => pitchForKey(key, DEFAULT_OCTAVE))).toEqual([
      60, 62, 64, 65, 67, 69, 71, 72, 74, 76,
    ]);
  });

  it("puts the black keys where they physically sit, with the gaps", () => {
    expect(pitchForKey("w", DEFAULT_OCTAVE)).toBe(61); // C#
    expect(pitchForKey("e", DEFAULT_OCTAVE)).toBe(63); // D#
    // No key between E and F, so `r` is unmapped — the row has a hole
    // exactly where the keyboard does.
    expect(pitchForKey("r", DEFAULT_OCTAVE)).toBeNull();
    expect(pitchForKey("t", DEFAULT_OCTAVE)).toBe(66); // F#
    expect(pitchForKey("y", DEFAULT_OCTAVE)).toBe(68); // G#
    expect(pitchForKey("u", DEFAULT_OCTAVE)).toBe(70); // A#
    expect(pitchForKey("i", DEFAULT_OCTAVE)).toBeNull(); // B -> C, no black key
    expect(pitchForKey("o", DEFAULT_OCTAVE)).toBe(73);
    expect(pitchForKey("p", DEFAULT_OCTAVE)).toBe(75);
  });

  it("never leaves the MIDI range, however far the octave is shifted", () => {
    for (let octave = MIN_OCTAVE; octave <= MAX_OCTAVE; octave += 1) {
      for (const key of Object.keys({ a: 0, ";": 0, p: 0 })) {
        const pitch = pitchForKey(key, octave);
        if (pitch !== null) expect(pitch).toBeGreaterThanOrEqual(0);
        if (pitch !== null) expect(pitch).toBeLessThanOrEqual(127);
      }
    }
  });
});

describe("playing", () => {
  it("sounds a note on press and releases it on lift", () => {
    const { piano, sink } = rig();
    expect(piano.keyDown("a")).toBe("note");
    expect(sink.noteOn).toHaveBeenCalledWith(60, 100);
    expect(piano.held()).toEqual([60]);
    piano.keyUp("a");
    expect(sink.noteOff).toHaveBeenCalledWith(60);
    expect(piano.held()).toEqual([]);
  });

  it("ignores autorepeat — a held key is ONE note, not thirty a second", () => {
    const { piano, sink } = rig();
    piano.keyDown("a");
    for (let i = 0; i < 20; i += 1) piano.keyDown("a", { repeat: true });
    expect(sink.noteOn).toHaveBeenCalledTimes(1);
  });

  it("plays chords: every key is its own voice", () => {
    const { piano, sink } = rig();
    piano.keyDown("a");
    piano.keyDown("d");
    piano.keyDown("g");
    expect(piano.held()).toEqual([60, 64, 67]);
    piano.keyUp("d");
    expect(sink.noteOff).toHaveBeenCalledWith(64);
    expect(piano.held()).toEqual([60, 67]);
  });

  it("shifts octaves, releasing what is sounding first", () => {
    const { piano, sink } = rig();
    piano.keyDown("a");
    piano.keyDown("x"); // octave up
    // The held note was started at the old octave; its key now means a
    // different pitch, so a later keyup could not pair it.
    expect(sink.noteOff).toHaveBeenCalledWith(60);
    expect(piano.octave).toBe(DEFAULT_OCTAVE + 1);
    piano.keyDown("a");
    expect(sink.noteOn).toHaveBeenLastCalledWith(72, 100);
  });

  it("clamps the octave and the velocity at their ends", () => {
    const { piano } = rig(MAX_OCTAVE);
    piano.keyDown("x");
    expect(piano.octave).toBe(MAX_OCTAVE);
    for (let i = 0; i < 20; i += 1) piano.keyDown("v");
    expect(piano.velocity).toBe(127);
    for (let i = 0; i < 40; i += 1) piano.keyDown("c");
    expect(piano.velocity).toBeGreaterThanOrEqual(1);
  });

  it("reports what it did, so the caller knows when to preventDefault", () => {
    const { piano } = rig();
    expect(piano.keyDown("a")).toBe("note");
    expect(piano.keyDown("x")).toBe("control");
    expect(piano.keyDown("1")).toBe("ignored");
  });

  it("releases everything on demand (focus loss, transport stop)", () => {
    const { piano, sink } = rig();
    piano.keyDown("a");
    piano.keyDown("s");
    piano.releaseAll();
    expect(sink.noteOff).toHaveBeenCalledTimes(2);
    expect(piano.held()).toEqual([]);
  });
});

describe("the note recorder", () => {
  function recorder() {
    let tick = 0;
    const rec = createNoteRecorder(() => tick);
    return { rec, at: (next: number) => void (tick = next) };
  }

  it("pairs note-ons with note-offs into notes with real durations", () => {
    const { rec, at } = recorder();
    at(480);
    rec.noteOn(60, 100);
    at(960);
    rec.noteOff(60);
    expect(rec.finish()).toEqual([{ pitch: 60, vel: 100, start: 480, dur: 480 }]);
  });

  it("closes whatever is still held when the take ends", () => {
    const { rec, at } = recorder();
    at(0);
    rec.noteOn(60, 100);
    at(1920);
    // Stopping with a key still down must not lose the note.
    expect(rec.finish()).toEqual([{ pitch: 60, vel: 100, start: 0, dur: 1920 }]);
  });

  it("survives a loop wrap sending the clock backwards", () => {
    const { rec, at } = recorder();
    at(3800);
    rec.noteOn(64, 90);
    at(20); // the transport looped mid-note
    rec.noteOff(64);
    const [note] = rec.finish();
    // Neither a negative length nor a dropped note: the take stays complete.
    expect(note?.start).toBe(3800);
    expect(note?.dur).toBe(MIN_RECORDED_DUR_TICKS);
  });

  it("returns the take in document order and empties itself", () => {
    const { rec, at } = recorder();
    at(960);
    rec.noteOn(67, 100);
    rec.noteOff(67);
    at(0);
    rec.noteOn(60, 100);
    rec.noteOff(60);
    expect(rec.finish().map((n) => n.pitch)).toEqual([60, 67]);
    expect(rec.finish()).toEqual([]);
    expect(rec.hasNotes).toBe(false);
  });

  it("does not let a missed note-off swallow the rest of the take", () => {
    const { rec, at } = recorder();
    at(0);
    rec.noteOn(60, 100);
    at(480);
    rec.noteOn(60, 100); // same pitch again, no note-off in between
    at(960);
    rec.noteOff(60);
    expect(rec.finish()).toHaveLength(2);
  });
});
