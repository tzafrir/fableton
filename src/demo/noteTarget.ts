// SS12: "DeviceInstance's note methods are optional; NoteTarget's are
// required — the demo/engine adapts an instrument to a NoteTarget at the
// wiring point." This is that adapter, used once, where the demo chain
// connects its mounted synth to the transport's `resolveTarget`.

import type { DeviceInstance, NoteTarget } from "../types";

/**
 * Wraps a `DeviceInstance` as a `NoteTarget`, throwing up front if it is
 * missing any of the three note methods (a mis-registered effect passed in
 * by mistake, say) rather than failing silently the first time a clip plays.
 */
export function instrumentToNoteTarget(instance: DeviceInstance): NoteTarget {
  const { noteOn, noteOff, allNotesOff } = instance;
  if (noteOn === undefined || noteOff === undefined || allNotesOff === undefined) {
    throw new Error(
      "instrumentToNoteTarget: instance is missing noteOn/noteOff/allNotesOff — " +
        "only an instrument's DeviceInstance can be adapted to a NoteTarget",
    );
  }
  return {
    noteOn(pitch, vel, when) {
      noteOn(pitch, vel, when);
    },
    noteOff(pitch, when) {
      noteOff(pitch, when);
    },
    allNotesOff(when) {
      allNotesOff(when);
    },
  };
}
