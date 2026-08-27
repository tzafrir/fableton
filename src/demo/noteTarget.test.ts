import { describe, expect, it, vi } from "vitest";
import type { DeviceInstance } from "../types";
import { instrumentToNoteTarget } from "./noteTarget";

describe("instrumentToNoteTarget (SS12 adapter)", () => {
  it("throws when the instance is missing a required note method", () => {
    const instance: DeviceInstance = {
      connectParam: () => {},
      dispose: () => {},
      // no noteOn/noteOff/allNotesOff — e.g. an effect passed in by mistake.
    };
    expect(() => instrumentToNoteTarget(instance)).toThrow(/noteOn.*noteOff.*allNotesOff/);
  });

  it("throws when only some note methods are present", () => {
    const instance: DeviceInstance = {
      connectParam: () => {},
      dispose: () => {},
      noteOn: () => {},
    };
    expect(() => instrumentToNoteTarget(instance)).toThrow();
  });

  it("forwards noteOn/noteOff/allNotesOff verbatim, with exact args", () => {
    const noteOn = vi.fn();
    const noteOff = vi.fn();
    const allNotesOff = vi.fn();
    const instance: DeviceInstance = {
      connectParam: () => {},
      dispose: () => {},
      noteOn,
      noteOff,
      allNotesOff,
    };

    const target = instrumentToNoteTarget(instance);
    target.noteOn(60, 100, 1.5);
    target.noteOff(60, 2);
    target.allNotesOff(2.1);

    expect(noteOn).toHaveBeenCalledTimes(1);
    expect(noteOn).toHaveBeenCalledWith(60, 100, 1.5);
    expect(noteOff).toHaveBeenCalledTimes(1);
    expect(noteOff).toHaveBeenCalledWith(60, 2);
    expect(allNotesOff).toHaveBeenCalledTimes(1);
    expect(allNotesOff).toHaveBeenCalledWith(2.1);
  });
});
