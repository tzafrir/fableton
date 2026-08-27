// SS10 — the piano roll's edit vocabulary. Every verb is scoped to one clip
// and every one of them is ONE undo entry: a drag writes nothing while it
// moves (it previews, SS9) and commits once on release.

import type {
  ClipId,
  Command,
  IdFactory,
  Note,
  NoteDelta,
  NoteId,
  NoteInit,
  NoteSpan,
  NoteVelocityEdit,
  ProjectCommands,
  Ticks,
} from "../../types";
import { MIN_NOTE_TICKS } from "../../types";
import {
  MIN_NOTE_DUR_TICKS,
  clampNoteDelta,
  clampPitch,
  clampVelocity,
  clipOf,
  copyNote,
  makeCommand,
  notesByIds,
  setNoteMuted,
  sortNotesIfNeeded,
  tick,
  type DraftNote,
} from "./util";

export type NoteCommands = Pick<
  ProjectCommands,
  | "addNotes"
  | "deleteNotes"
  | "moveNotes"
  | "resizeNotes"
  | "setNoteVelocities"
  | "setNotesMuted"
  | "duplicateNotes"
  | "quantizeNoteStarts"
>;

/** A `NoteInit` normalized into a document-legal `Note` (invariant 5). */
export function noteFromInit(init: NoteInit, id: NoteId): Note {
  const note: Note = {
    id,
    start: Math.max(0, tick(init.start)),
    dur: Math.max(MIN_NOTE_DUR_TICKS, tick(init.dur)),
    pitch: clampPitch(init.pitch),
    vel: clampVelocity(init.vel),
  };
  if (init.muted === true) note.muted = true;
  return note;
}

function applyDelta(notes: DraftNote[], delta: NoteDelta): boolean {
  const clamped = clampNoteDelta(notes, delta);
  if (clamped.ticks === 0 && clamped.pitch === 0) return false;
  for (const note of notes) {
    note.start += clamped.ticks;
    note.pitch += clamped.pitch;
  }
  return true;
}

export function createNoteCommands(ids: IdFactory): NoteCommands {
  return {
    addNotes(clipId: ClipId, notes: readonly NoteInit[]): Command {
      // Ids are minted HERE, never inside `run` — redo replays patches.
      const created = notes.map((init) => noteFromInit(init, init.id ?? ids.note()));
      return makeCommand(created.length === 1 ? "Add Note" : "Add Notes", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined || created.length === 0) return;
        const existing = new Set(clip.notes.map((note) => note.id));
        for (const note of created) {
          if (existing.has(note.id)) continue;
          existing.add(note.id);
          clip.notes.push({ ...note });
        }
        sortNotesIfNeeded(clip.notes);
      });
    },

    deleteNotes(clipId: ClipId, noteIds: readonly NoteId[]): Command {
      const doomed = new Set(noteIds);
      return makeCommand(doomed.size === 1 ? "Delete Note" : "Delete Notes", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined || doomed.size === 0) return;
        for (let i = clip.notes.length - 1; i >= 0; i--) {
          const note = clip.notes[i];
          if (note !== undefined && doomed.has(note.id)) clip.notes.splice(i, 1);
        }
      });
    },

    moveNotes(clipId: ClipId, noteIds: readonly NoteId[], delta: NoteDelta): Command {
      return makeCommand("Move Notes", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined) return;
        const targets = notesByIds(clip, noteIds);
        if (targets.length === 0) return;
        if (applyDelta(targets, delta)) sortNotesIfNeeded(clip.notes);
      });
    },

    resizeNotes(clipId: ClipId, spans: readonly NoteSpan[]): Command {
      return makeCommand("Resize Notes", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined || spans.length === 0) return;
        const byId = new Map(clip.notes.map((note) => [note.id, note] as const));
        for (const span of spans) {
          const note = byId.get(span.id);
          if (note === undefined) continue;
          // The handler already snapped the moving edge and left the anchored
          // one alone (SS10); the floor is the kit's 1/128 note.
          note.start = Math.max(0, tick(span.start));
          note.dur = Math.max(MIN_NOTE_TICKS, tick(span.dur));
        }
        sortNotesIfNeeded(clip.notes);
      });
    },

    setNoteVelocities(clipId: ClipId, edits: readonly NoteVelocityEdit[]): Command {
      return makeCommand("Set Velocity", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined || edits.length === 0) return;
        const byId = new Map(clip.notes.map((note) => [note.id, note] as const));
        for (const edit of edits) {
          const note = byId.get(edit.id);
          if (note === undefined) continue;
          note.vel = clampVelocity(edit.vel);
        }
      });
    },

    setNotesMuted(clipId: ClipId, noteIds: readonly NoteId[], muted: boolean): Command {
      return makeCommand(muted ? "Mute Notes" : "Unmute Notes", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined) return;
        for (const note of notesByIds(clip, noteIds)) setNoteMuted(note, muted);
      });
    },

    duplicateNotes(
      clipId: ClipId,
      noteIds: readonly NoteId[],
      delta: NoteDelta,
      newIds?: readonly NoteId[] | undefined,
    ): Command {
      // One id per source note, in the caller's order, minted eagerly.
      const minted = noteIds.map((_, i) => newIds?.[i] ?? ids.note());
      return makeCommand("Duplicate Notes", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined) return;
        const byId = new Map(clip.notes.map((note) => [note.id, note] as const));
        const sources = noteIds
          .map((id, i) => ({ note: byId.get(id), id: minted[i] }))
          .filter((entry): entry is { note: DraftNote; id: NoteId } => entry.note !== undefined && entry.id !== undefined);
        if (sources.length === 0) return;
        const clamped = clampNoteDelta(
          sources.map((entry) => entry.note),
          delta,
        );
        const existing = new Set(clip.notes.map((note) => note.id));
        for (const entry of sources) {
          if (existing.has(entry.id)) continue;
          existing.add(entry.id);
          const copy = copyNote(entry.note, entry.id);
          copy.start += clamped.ticks;
          copy.pitch += clamped.pitch;
          clip.notes.push(copy);
        }
        sortNotesIfNeeded(clip.notes);
      });
    },

    quantizeNoteStarts(clipId: ClipId, noteIds: readonly NoteId[], gridTicks: Ticks): Command {
      const grid = Math.max(1, tick(gridTicks));
      return makeCommand("Quantize", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined) return;
        const targets = notesByIds(clip, noteIds);
        if (targets.length === 0) return;
        for (const note of targets) {
          note.start = Math.max(0, Math.round(note.start / grid) * grid);
        }
        sortNotesIfNeeded(clip.notes);
      });
    },
  };
}
