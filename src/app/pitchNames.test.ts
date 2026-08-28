// The shell's clip -> instrument -> note-names join (SS7 `noteNames`).

import { describe, expect, it } from "vitest";
import { DrumMachine, PADS } from "../devices/core";
import { createProjectCommands } from "../state/commands";
import { createSequentialIdFactory } from "../state/ids";
import { createEmptyProject } from "../state/project";
import { createDocumentStore } from "../state/store";
import { pitchNamesForClip, pitchNamesOfDefinition } from "./pitchNames";

function fixture() {
  const ids = createSequentialIdFactory();
  const commands = createProjectCommands(ids);
  const project = createEmptyProject({ ids });
  const store = createDocumentStore(project, { now: () => 0 });
  const clipId = Object.keys(project.clips)[0] ?? "";
  const trackId = store.getState().clips[clipId]?.trackId ?? "";
  return { store, commands, clipId, trackId };
}

describe("pitchNamesOfDefinition", () => {
  it("names every pad of the drum machine", () => {
    const names = pitchNamesOfDefinition(DrumMachine.id);
    expect(names).not.toBeNull();
    for (const pad of PADS) expect(names?.get(pad.note)).toBe(pad.label);
  });

  it("returns null for a chromatic instrument, and for an unknown id", () => {
    expect(pitchNamesOfDefinition("core.poly-synth")).toBeNull();
    expect(pitchNamesOfDefinition("core.nothing-like-this")).toBeNull();
  });

  it("returns the SAME map object every time", () => {
    // Identity is load-bearing: the roll re-frames when the map changes, and
    // the shell recomputes this on every document change.
    expect(pitchNamesOfDefinition(DrumMachine.id)).toBe(pitchNamesOfDefinition(DrumMachine.id));
  });
});

describe("pitchNamesForClip", () => {
  it("is null for the starter project's poly synth", () => {
    const f = fixture();
    expect(pitchNamesForClip(f.store.getState(), f.clipId)).toBeNull();
  });

  it("follows the track's instrument after a swap", () => {
    const f = fixture();
    f.store.dispatch(f.commands.setInstrument(f.trackId, { definitionId: DrumMachine.id }));
    const names = pitchNamesForClip(f.store.getState(), f.clipId);
    expect(names?.get(36)).toBe("Kick");
  });

  it("is null with no clip open, and for a clip that no longer exists", () => {
    const f = fixture();
    expect(pitchNamesForClip(f.store.getState(), null)).toBeNull();
    expect(pitchNamesForClip(f.store.getState(), "gone")).toBeNull();
  });
});
