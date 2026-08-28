// SS10 semantics: relative moves, absolute resizes, sorted storage.

import { describe, expect, it } from "vitest";
import { MIN_NOTE_TICKS } from "../../types";
import { BAR, EIGHTH, QUARTER, SIXTEENTH, makeFixture, makeFixtureWithNotes, notes } from "../testing/fixture";
import { expectLegalProject } from "../testing/invariants";

const noteList = (fixture: ReturnType<typeof makeFixture>) =>
  fixture.store.getState().clips[fixture.clipId]?.notes ?? [];

describe("note commands", () => {
  it("addNotes mints ids eagerly and keeps the array sorted by (start, pitch)", () => {
    const f = makeFixture();
    const result = f.store.dispatch(
      f.commands.addNotes(f.clipId, notes([[QUARTER, 72], [0, 64], [0, 60]])),
    );
    expect(result.status).toBe("applied");
    expect(noteList(f).map((note) => [note.start, note.pitch])).toEqual([
      [0, 60],
      [0, 64],
      [QUARTER, 72],
    ]);
    // The ids exist before `run` — that is what makes redo (which replays
    // patches, never re-runs) reproduce the same document.
    expect(noteList(f).map((note) => note.id).sort()).toEqual(["note-1", "note-2", "note-3"]);
  });

  it("addNotes accepts pinned ids and clamps out-of-range values", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { id: "pinned", start: -50, dur: 0, pitch: 200, vel: 0 },
      ]),
    );
    expect(noteList(f)[0]).toEqual({ id: "pinned", start: 0, dur: 1, pitch: 127, vel: 1 });
    expectLegalProject(structuredClone(f.store.getState()));
  });

  it("addNotes ignores an id the clip already holds", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ id: "n", start: 0, dur: 100, pitch: 60, vel: 100 }]));
    const result = f.store.dispatch(
      f.commands.addNotes(f.clipId, [{ id: "n", start: QUARTER, dur: 100, pitch: 62, vel: 100 }]),
    );
    expect(result.status).toBe("noop");
    expect(noteList(f)).toHaveLength(1);
  });

  it("moveNotes shifts by a RELATIVE delta, preserving off-grid offsets", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ id: "a", start: 17, dur: 100, pitch: 60, vel: 100 }]));
    f.store.dispatch(f.commands.moveNotes(f.clipId, ["a"], { ticks: QUARTER, pitch: 2 }));
    expect(noteList(f)[0]?.start).toBe(QUARTER + 17);
    expect(noteList(f)[0]?.pitch).toBe(62);
  });

  it("clamps the DELTA, not each note: a chord keeps its shape at the edges", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { id: "low", start: 0, dur: 100, pitch: 2, vel: 100 },
        { id: "high", start: QUARTER, dur: 100, pitch: 9, vel: 100 },
      ]),
    );
    f.store.dispatch(f.commands.moveNotes(f.clipId, ["low", "high"], { ticks: -BAR, pitch: -40 }));
    const byId = new Map(noteList(f).map((note) => [note.id, note]));
    // The lowest note pins the move at pitch 0; the interval survives.
    expect(byId.get("low")?.pitch).toBe(0);
    expect(byId.get("high")?.pitch).toBe(7);
    expect(byId.get("low")?.start).toBe(0);
    expect(byId.get("high")?.start).toBe(QUARTER);
  });

  it("moveNotes only touches the named notes", () => {
    const f = makeFixtureWithNotes();
    const before = noteList(f).find((note) => note.pitch === 72)?.start;
    f.store.dispatch(f.commands.moveNotes(f.clipId, ["note-1"], { ticks: EIGHTH, pitch: 0 }));
    expect(noteList(f).find((note) => note.pitch === 72)?.start).toBe(before);
  });

  it("moveNotes with nothing selected is a noop", () => {
    const f = makeFixtureWithNotes();
    expect(f.store.dispatch(f.commands.moveNotes(f.clipId, [], { ticks: 100, pitch: 1 })).status).toBe("noop");
    expect(f.store.dispatch(f.commands.moveNotes(f.clipId, ["gone"], { ticks: 100, pitch: 1 })).status).toBe("noop");
  });

  it("resizeNotes takes absolute spans and floors dur at MIN_NOTE_TICKS", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ id: "a", start: QUARTER, dur: QUARTER, pitch: 60, vel: 100 }]));
    f.store.dispatch(f.commands.resizeNotes(f.clipId, [{ id: "a", start: SIXTEENTH, dur: 1 }]));
    expect(noteList(f)[0]?.start).toBe(SIXTEENTH);
    expect(noteList(f)[0]?.dur).toBe(MIN_NOTE_TICKS);
  });

  it("setNoteVelocities clamps to 1-127", () => {
    const f = makeFixtureWithNotes();
    f.store.dispatch(
      f.commands.setNoteVelocities(f.clipId, [
        { id: "note-1", vel: 0 },
        { id: "note-2", vel: 500 },
      ]),
    );
    const byId = new Map(noteList(f).map((note) => [note.id, note]));
    expect(byId.get("note-1")?.vel).toBe(1);
    expect(byId.get("note-2")?.vel).toBe(127);
  });

  it("setNotesMuted writes an absent key rather than `muted: false`", () => {
    const f = makeFixtureWithNotes();
    f.store.dispatch(f.commands.setNotesMuted(f.clipId, ["note-1"], true));
    const muted = noteList(f).find((note) => note.id === "note-1");
    expect(muted?.muted).toBe(true);
    f.store.dispatch(f.commands.setNotesMuted(f.clipId, ["note-1"], false));
    const unmuted = noteList(f).find((note) => note.id === "note-1");
    expect(Object.hasOwn(unmuted ?? {}, "muted")).toBe(false);
  });

  it("duplicateNotes copies with new ids and one shared delta", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ id: "a", start: 0, dur: 100, pitch: 60, vel: 100 }]));
    f.store.dispatch(f.commands.duplicateNotes(f.clipId, ["a"], { ticks: QUARTER, pitch: 0 }, ["a-copy"]));
    expect(noteList(f).map((note) => [note.id, note.start])).toEqual([
      ["a", 0],
      ["a-copy", QUARTER],
    ]);
  });

  it("quantizeNoteStarts snaps starts to the grid and leaves durations alone", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { id: "early", start: SIXTEENTH - 20, dur: 333, pitch: 60, vel: 100 },
        { id: "late", start: SIXTEENTH + 20, dur: 333, pitch: 62, vel: 100 },
      ]),
    );
    f.store.dispatch(f.commands.quantizeNoteStarts(f.clipId, ["early", "late"], SIXTEENTH));
    for (const note of noteList(f)) {
      expect(note.start).toBe(SIXTEENTH);
      expect(note.dur).toBe(333);
    }
  });

  it("deleteNotes removes exactly the named notes", () => {
    const f = makeFixtureWithNotes();
    f.store.dispatch(f.commands.deleteNotes(f.clipId, ["note-1", "note-4"]));
    expect(noteList(f).map((note) => note.id)).toEqual(["note-2", "note-3"]);
  });

  it("every note command on a missing clip is a noop, never a throw", () => {
    const f = makeFixture();
    const { commands, store } = f;
    for (const command of [
      commands.addNotes("gone", notes([[0, 60]])),
      commands.deleteNotes("gone", ["x"]),
      commands.moveNotes("gone", ["x"], { ticks: 1, pitch: 1 }),
      commands.resizeNotes("gone", [{ id: "x", start: 0, dur: 10 }]),
      commands.setNoteVelocities("gone", [{ id: "x", vel: 10 }]),
      commands.setNotesMuted("gone", ["x"], true),
      commands.duplicateNotes("gone", ["x"], { ticks: 1, pitch: 0 }),
      commands.quantizeNoteStarts("gone", ["x"], SIXTEENTH),
    ]) {
      expect(store.dispatch(command).status).toBe("noop");
    }
  });
});

describe("arpeggiateNotes", () => {
  const STEP = 240;
  const options = { step: STEP, mode: "up" as const, octaves: 1, gate: 90 };

  /** A C-major triad held for a bar, as the only content of the clip. */
  function chordFixture() {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { id: "c", start: 0, dur: BAR, pitch: 60, vel: 100 },
        { id: "e", start: 0, dur: BAR, pitch: 64, vel: 100 },
        { id: "g", start: 0, dur: BAR, pitch: 67, vel: 100 },
      ]),
    );
    return f;
  }

  const notesOf = (f: ReturnType<typeof makeFixture>) =>
    f.store.getState().clips[f.clipId]?.notes ?? [];

  it("replaces the chord with the arpeggio, in one undo entry", () => {
    const f = chordFixture();
    f.store.dispatch(f.commands.arpeggiateNotes(f.clipId, ["c", "e", "g"], options));
    const notes = notesOf(f);
    expect(notes).toHaveLength(BAR / STEP);
    expect(notes.slice(0, 3).map((n) => n.pitch)).toEqual([60, 64, 67]);
    expect(f.store.undoLabel()).toBe("Arpeggiate");

    f.store.undo();
    expect(notesOf(f).map((n) => n.id)).toEqual(["c", "e", "g"]);
  });

  it("leaves notes it was not given alone", () => {
    const f = chordFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [{ id: "bass", start: 0, dur: BAR, pitch: 36, vel: 100 }]),
    );
    f.store.dispatch(f.commands.arpeggiateNotes(f.clipId, ["c", "e", "g"], options));
    expect(notesOf(f).some((n) => n.id === "bass")).toBe(true);
  });

  it("mints ids that do not collide with the notes it kept", () => {
    const f = chordFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { id: `${f.clipId}-arp-0`, start: BAR, dur: 240, pitch: 36, vel: 100 },
      ]),
    );
    f.store.dispatch(f.commands.arpeggiateNotes(f.clipId, ["c", "e", "g"], options));
    const ids = notesOf(f).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes pinned ids when the caller supplies them", () => {
    const f = chordFixture();
    const pinned = Array.from({ length: BAR / STEP }, (_, i) => `arp-${String(i)}`);
    f.store.dispatch(f.commands.arpeggiateNotes(f.clipId, ["c", "e", "g"], options, pinned));
    expect(notesOf(f).map((n) => n.id)).toEqual(pinned);
  });

  it("does nothing for an empty selection or an unknown clip", () => {
    const f = chordFixture();
    const before = notesOf(f).length;
    f.store.dispatch(f.commands.arpeggiateNotes(f.clipId, [], options));
    f.store.dispatch(f.commands.arpeggiateNotes("nope", ["c"], options));
    expect(notesOf(f)).toHaveLength(before);
  });

  it("leaves the clip's notes sorted (document invariant 4)", () => {
    const f = chordFixture();
    f.store.dispatch(f.commands.arpeggiateNotes(f.clipId, ["c", "e", "g"], options));
    expectLegalProject(f.store.getState());
  });
});
