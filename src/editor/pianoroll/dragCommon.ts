// Helpers every SS10 drag handler shares, so the rules that MUST be identical
// across the FSM rows are written once:
//
//   * which notes a gesture acts on (the hit note, or the whole selection when
//     the hit note is part of it),
//   * SS10's relative snap + `Alt` bypass, taken from the kit's `snapping.ts`
//     rather than re-spelled here,
//   * the same clamping the commands apply, so a ghost never shows a position
//     the command would refuse (pitch 0-127, start >= 0),
//   * SS10's "audition on pitch change" — UI, never the scheduler.

import type { NoteId } from "../../types/ids";
import type { Ticks } from "../../types/time";
import { MAX_PITCH, MIN_PITCH, type RONote } from "./layout";
import type { PianoRollContext } from "./context";
import type { GhostNote } from "./preview";

/**
 * SS10 `Pending` -> a drag that starts on a selected note moves the whole
 * selection; one that starts elsewhere acts on that note alone.
 */
export function dragTargets(ctx: PianoRollContext, noteId: NoteId): readonly RONote[] {
  if (ctx.selection.has(noteId)) {
    const selected = ctx.selectedNotes();
    if (selected.length > 0) return selected;
  }
  const note = ctx.noteById(noteId);
  return note === undefined ? [] : [note];
}

export function idsOf(notes: readonly RONote[]): NoteId[] {
  return notes.map((note) => note.id);
}

export interface ClampedDelta {
  readonly ticks: Ticks;
  readonly pitch: number;
}

/**
 * Mirrors `command-undo`'s `clampNoteDelta`: no note may start before 0 or
 * leave 0-127, and the WHOLE group shifts by the same clamped delta so a
 * chord never collapses (SS10 "moves are relative").
 */
export function clampGroupDelta(
  notes: readonly RONote[],
  deltaTicks: Ticks,
  deltaPitch: number,
): ClampedDelta {
  if (notes.length === 0) return { ticks: 0, pitch: 0 };
  let minStart = Number.POSITIVE_INFINITY;
  let minPitch = Number.POSITIVE_INFINITY;
  let maxPitch = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note.start < minStart) minStart = note.start;
    if (note.pitch < minPitch) minPitch = note.pitch;
    if (note.pitch > maxPitch) maxPitch = note.pitch;
  }
  const ticks = Math.max(deltaTicks, -minStart);
  const pitch = Math.min(
    Math.max(deltaPitch, MIN_PITCH - minPitch),
    MAX_PITCH - maxPitch,
  );
  return { ticks, pitch };
}

export function ghostOf(note: RONote, deltaTicks: Ticks, deltaPitch: number): GhostNote {
  return {
    id: note.id,
    start: note.start + deltaTicks,
    dur: note.dur,
    pitch: note.pitch + deltaPitch,
    vel: note.vel,
  };
}

/**
 * SS10: "ghosts at snapped Delta-tick/Delta-pitch; AUDITION ON PITCH CHANGE".
 * Auditions are UI (SS10 note in types/editor): immediate, never scheduled,
 * never undoable. Returns the pitch now sounding.
 */
export function auditionPitchChange(
  ctx: PianoRollContext,
  previous: number | null,
  next: number | null,
  vel: number,
): number | null {
  if (previous === next) return previous;
  const sink = ctx.audition;
  if (sink === null) return next;
  if (previous !== null) sink.noteOff(previous);
  if (next !== null) sink.noteOn(next, vel);
  return next;
}

export function stopAudition(ctx: PianoRollContext, pitch: number | null): void {
  const sink = ctx.audition;
  if (sink === null || pitch === null) return;
  sink.noteOff(pitch);
}
