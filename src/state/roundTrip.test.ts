// SS13's load-bearing claim: "execution produces immer-style patches, and
// inverse patches make undo/redo mechanical."
//
// The whole undo system rests on ONE property — for every command,
//
//     applyPatches(before, patches) === after
//     applyPatches(after, inverse)  === before
//
// exactly, byte for byte. This file asserts it over the entire M1 vocabulary
// rather than trusting immer, because the commands do things (sorting notes,
// splicing arrays, deleting keys) whose patch shapes are the interesting part.

import { describe, expect, it } from "vitest";
import { applyPatches, type Patch as ImmerPatch } from "immer";
import type { Command, Patch, Project } from "../types";
import { makeFixture, notes, BAR, EIGHTH, QUARTER, SIXTEENTH } from "./testing/fixture";
import { expectLegalProject } from "./testing/invariants";

function toImmer(patches: readonly Patch[]): ImmerPatch[] {
  return patches.map((patch) => {
    const out: ImmerPatch = { op: patch.op, path: [...patch.path] };
    if (patch.op !== "remove") out.value = patch.value;
    return out;
  });
}

interface Case {
  name: string;
  /** Commands run before the one under test (setup, not asserted on). */
  setup?: (fixture: ReturnType<typeof makeFixture>) => void;
  command: (fixture: ReturnType<typeof makeFixture>) => Command;
}

const cases: Case[] = [
  {
    name: "addNotes",
    command: (f) => f.commands.addNotes(f.clipId, notes([[0, 60], [EIGHTH, 64]])),
  },
  {
    name: "addNotes into an existing, sorted clip (forces a reorder)",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[QUARTER, 60], [BAR - EIGHTH, 72]])));
    },
    command: (f) => f.commands.addNotes(f.clipId, notes([[0, 48], [EIGHTH, 55]])),
  },
  {
    name: "deleteNotes",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [EIGHTH, 64], [QUARTER, 67]])));
    },
    command: (f) => f.commands.deleteNotes(f.clipId, ["note-1", "note-3"]),
  },
  {
    name: "moveNotes (reorders the array)",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [EIGHTH, 64], [QUARTER, 67]])));
    },
    command: (f) => f.commands.moveNotes(f.clipId, ["note-1"], { ticks: QUARTER + EIGHTH, pitch: 5 }),
  },
  {
    name: "resizeNotes",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [EIGHTH, 64]])));
    },
    command: (f) =>
      f.commands.resizeNotes(f.clipId, [
        { id: "note-1", start: 0, dur: QUARTER },
        { id: "note-2", start: SIXTEENTH, dur: SIXTEENTH },
      ]),
  },
  {
    name: "setNoteVelocities",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [EIGHTH, 64]])));
    },
    command: (f) => f.commands.setNoteVelocities(f.clipId, [{ id: "note-1", vel: 30 }]),
  },
  {
    name: "setNotesMuted true (adds an optional key)",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [EIGHTH, 64]])));
    },
    command: (f) => f.commands.setNotesMuted(f.clipId, ["note-1"], true),
  },
  {
    name: "setNotesMuted false (removes an optional key)",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
      f.store.dispatch(f.commands.setNotesMuted(f.clipId, ["note-1"], true));
    },
    command: (f) => f.commands.setNotesMuted(f.clipId, ["note-1"], false),
  },
  {
    name: "duplicateNotes",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [EIGHTH, 64]])));
    },
    command: (f) => f.commands.duplicateNotes(f.clipId, ["note-1", "note-2"], { ticks: QUARTER, pitch: 0 }),
  },
  {
    name: "quantizeNoteStarts",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[13, 60], [EIGHTH + 7, 64]])));
    },
    command: (f) => f.commands.quantizeNoteStarts(f.clipId, ["note-1", "note-2"], SIXTEENTH),
  },
  {
    name: "createClip with notes",
    command: (f) =>
      f.commands.createClip({
        trackId: f.trackId,
        start: BAR,
        length: BAR,
        notes: notes([[EIGHTH, 64], [0, 60]]),
        name: "Second",
        color: "#ff0000",
      }),
  },
  { name: "deleteClips", command: (f) => f.commands.deleteClips([f.clipId]) },
  {
    name: "moveClips",
    setup: (f) => {
      f.store.dispatch(f.commands.addTrack({ name: "Track 2" }));
    },
    command: (f) => f.commands.moveClips([f.clipId], { ticks: BAR, tracks: 1 }),
  },
  {
    name: "trimClips from the left (drops and clips notes)",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [QUARTER, 64], [BAR - EIGHTH, 67]])));
    },
    command: (f) => f.commands.trimClips([{ id: f.clipId, start: QUARTER, length: BAR - QUARTER }]),
  },
  {
    name: "trimClips from the right",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
    },
    command: (f) => f.commands.trimClips([{ id: f.clipId, start: 0, length: QUARTER }]),
  },
  {
    name: "splitClip (splits a crossing note)",
    setup: (f) => {
      f.store.dispatch(
        f.commands.addNotes(f.clipId, [
          { start: 0, dur: BAR, pitch: 60, vel: 100 },
          { start: QUARTER * 3, dur: EIGHTH, pitch: 72, vel: 100 },
        ]),
      );
    },
    command: (f) => f.commands.splitClip(f.clipId, QUARTER * 2),
  },
  {
    name: "duplicateClips",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
    },
    command: (f) => f.commands.duplicateClips([f.clipId], { ticks: BAR, tracks: 0 }),
  },
  { name: "setClipLoop", command: (f) => f.commands.setClipLoop(f.clipId, { start: 0, end: QUARTER }) },
  {
    name: "setClipLoop(null)",
    setup: (f) => {
      f.store.dispatch(f.commands.setClipLoop(f.clipId, { start: 0, end: QUARTER }));
    },
    command: (f) => f.commands.setClipLoop(f.clipId, null),
  },
  { name: "renameClip", command: (f) => f.commands.renameClip(f.clipId, "Verse") },
  { name: "setClipColor", command: (f) => f.commands.setClipColor(f.clipId, "#00ff00") },
  {
    name: "addTrack with an instrument",
    command: (f) => f.commands.addTrack({ name: "Bass", instrument: { definitionId: "core.poly-synth" } }),
  },
  { name: "addTrack at index 0", command: (f) => f.commands.addTrack({ index: 0 }) },
  {
    name: "deleteTracks (clips, devices, params and all)",
    setup: (f) => {
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
      f.store.dispatch(f.commands.setParamValue(`chan:${f.trackId}/dev:${f.deviceId}/cutoff`, 800));
    },
    command: (f) => f.commands.deleteTracks([f.trackId]),
  },
  { name: "renameChannel", command: (f) => f.commands.renameChannel(f.trackId, "Lead") },
  { name: "setChannelColor", command: (f) => f.commands.setChannelColor(f.trackId, "#123456") },
  {
    name: "moveChannel",
    setup: (f) => {
      f.store.dispatch(f.commands.addTrack({}));
      f.store.dispatch(f.commands.addTrack({}));
    },
    command: (f) => f.commands.moveChannel(f.trackId, 2),
  },
  { name: "setChannelMuted", command: (f) => f.commands.setChannelMuted(f.trackId, true) },
  { name: "setChannelSolo", command: (f) => f.commands.setChannelSolo(f.trackId, true) },
  {
    name: "setParamValue on a param the document already has",
    command: (f) => f.commands.setParamValue(`chan:${f.trackId}/vol`, -6),
  },
  {
    name: "setParamValue on a NEW param key (inverse must remove it)",
    command: (f) => f.commands.setParamValue(`chan:${f.trackId}/dev:${f.deviceId}/cutoff`, 1200),
  },
  {
    name: "setParamValues",
    command: (f) =>
      f.commands.setParamValues({
        [`chan:${f.trackId}/vol`]: -3,
        [`chan:${f.masterId}/pan`]: 0.25,
      }),
  },
  { name: "renameProject", command: (f) => f.commands.renameProject("Song") },
  { name: "setTempo", command: (f) => f.commands.setTempo(140) },
  { name: "setTimeSignature", command: (f) => f.commands.setTimeSignature({ numerator: 6, denominator: 8 }) },
  { name: "setLoopRegion", command: (f) => f.commands.setLoopRegion({ start: BAR, end: BAR * 3, enabled: true }) },
  {
    name: "custom",
    command: (f) =>
      f.commands.custom("Nudge Everything", (doc) => {
        for (const clip of Object.values(doc.clips)) clip.start += SIXTEENTH;
      }),
  },
];

describe("patch round trip", () => {
  for (const testCase of cases) {
    it(`${testCase.name}: patches replay forward and invert exactly`, () => {
      const fixture = makeFixture();
      testCase.setup?.(fixture);
      const before = structuredClone(fixture.store.getState()) as Project;

      const result = fixture.store.dispatch(testCase.command(fixture));
      expect(result.status).toBe("applied");
      if (result.status !== "applied") return;
      expect(result.patches.length).toBeGreaterThan(0);

      const after = structuredClone(fixture.store.getState()) as Project;
      expect(after).not.toEqual(before);

      // Forward: the recorded patches ARE the edit (this is what redo replays
      // and what a subscriber applies to its own mirror).
      expect(applyPatches(before, toImmer(result.patches))).toEqual(after);

      // Backward: the inverse patches undo it exactly, key order included.
      const undone = applyPatches(after, toImmer(result.inverse)) as Project;
      expect(undone).toEqual(before);
      expect(JSON.stringify(undone)).toBe(JSON.stringify(before));

      expectLegalProject(after);
      expectLegalProject(undone);
    });

    it(`${testCase.name}: store undo/redo reproduces both states`, () => {
      const fixture = makeFixture();
      testCase.setup?.(fixture);
      const before = structuredClone(fixture.store.getState()) as Project;
      const result = fixture.store.dispatch(testCase.command(fixture));
      if (result.status !== "applied") throw new Error(`expected applied, got ${result.status}`);
      const after = structuredClone(fixture.store.getState()) as Project;

      expect(fixture.store.undo()).not.toBeNull();
      expect(fixture.store.getState()).toEqual(before);
      expect(JSON.stringify(fixture.store.getState())).toBe(JSON.stringify(before));

      expect(fixture.store.redo()).not.toBeNull();
      expect(fixture.store.getState()).toEqual(after);
      expect(JSON.stringify(fixture.store.getState())).toBe(JSON.stringify(after));

      // ...and again, because a redo must leave the history in a state a
      // second undo can still unwind.
      expect(fixture.store.undo()).not.toBeNull();
      expect(fixture.store.getState()).toEqual(before);
    });
  }
});
