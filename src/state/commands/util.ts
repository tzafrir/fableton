// Shared helpers for the command factories. Everything here is pure and
// operates on an immer draft (or on plain data), so the same code paths are
// exercised by the round-trip patch tests.

import type {
  ChannelId,
  Command,
  DeviceInstanceId,
  Draft,
  MidiClip,
  Note,
  NoteDelta,
  NoteId,
  Project,
  ProjectSnapshot,
  Ticks,
} from "../../types";
import { findMasterChannelId } from "../project";

export type DraftProject = Draft<Project>;
export type DraftClip = Draft<MidiClip>;
export type DraftNote = Draft<Note>;

/**
 * Detaches a device id from every list that can hold it on its channel: the
 * channel's own chain, and any chain of any rack on that channel. The device
 * itself is untouched — this is the list bookkeeping alone, shared by the
 * routing commands and the rack commands so the two cannot drift about where
 * a device may live (SS7 racks: a device belongs to exactly ONE list).
 */
export function detachFromChains(doc: DraftProject, deviceId: DeviceInstanceId): void {
  const device = doc.devices[deviceId];
  if (device === undefined) return;
  const channel = doc.channels[device.channelId];
  if (channel !== undefined) {
    channel.chain = channel.chain.filter((id) => id !== deviceId);
    if (channel.midiChain !== undefined) {
      const kept = channel.midiChain.filter((id) => id !== deviceId);
      // Dropped entirely when it empties: an absent `midiChain` and an empty
      // one mean the same thing, and only one of the two encodes to nothing.
      if (kept.length === 0) delete channel.midiChain;
      else channel.midiChain = kept;
    }
    if (channel.source !== null && channel.source.deviceId === deviceId) channel.source = null;
  }
  for (const rack of Object.values(doc.racks)) {
    for (const chain of rack.chains) {
      if (chain.devices.includes(deviceId)) {
        chain.devices = chain.devices.filter((id) => id !== deviceId);
      }
    }
  }
}

/** Document invariant 5: note `dur` is an integer >= 1. */
export const MIN_NOTE_DUR_TICKS = 1;

export interface CommandExtras {
  canRun?: ((doc: ProjectSnapshot) => string | null) | undefined;
  coalesceKey?: string | undefined;
}

/** Builds a `Command`, omitting optional members entirely rather than
 *  setting them to `undefined` (tsconfig `exactOptionalPropertyTypes`). */
export function makeCommand(
  label: string,
  run: (doc: DraftProject) => void,
  extras: CommandExtras = {},
): Command {
  const command: Command = { label, run };
  if (extras.canRun !== undefined) command.canRun = extras.canRun;
  if (extras.coalesceKey !== undefined) command.coalesceKey = extras.coalesceKey;
  return command;
}

/** SS8: every tick in the document is an integer. */
export function tick(value: number): Ticks {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, tick(value)));
}

export function clampPitch(value: number): number {
  return clampInt(value, 0, 127);
}

/** MIDI velocity is 1-127 (invariant 5): 0 would mean note-off. */
export function clampVelocity(value: number): number {
  return clampInt(value, 1, 127);
}

/**
 * Document invariant 4: `clip.notes` stays SORTED by `(start, pitch)`. The
 * kit's culling binary-searches this array (SS9) and stable order is what
 * makes save output byte-stable (SS2). Ties beyond `(start, pitch)` break on
 * id so the order is total and reproducible.
 */
export function sortNotes(notes: DraftNote[]): void {
  notes.sort(
    (a, b) => a.start - b.start || a.pitch - b.pitch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** True when the array already satisfies invariant 4 — checked before
 *  sorting so an ordered edit produces no reorder patches. */
export function notesAreSorted(notes: readonly { start: number; pitch: number; id: string }[]): boolean {
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1];
    const b = notes[i];
    if (a === undefined || b === undefined) continue;
    if (a.start !== b.start) {
      if (a.start > b.start) return false;
      continue;
    }
    if (a.pitch !== b.pitch) {
      if (a.pitch > b.pitch) return false;
      continue;
    }
    if (a.id > b.id) return false;
  }
  return true;
}

export function sortNotesIfNeeded(notes: DraftNote[]): void {
  if (!notesAreSorted(notes)) sortNotes(notes);
}

export function clipOf(doc: DraftProject, clipId: string): DraftClip | undefined {
  return doc.clips[clipId];
}

/** The notes of `clip` whose ids are in `ids`, in document order. */
export function notesByIds(clip: DraftClip, ids: readonly NoteId[]): DraftNote[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  return clip.notes.filter((note) => wanted.has(note.id));
}

/**
 * SS10 "Moves are relative": the delta shifts the whole selection, so
 * off-grid offsets and the shape of a chord survive. Clamping is therefore
 * applied to the DELTA (the tightest constraint any selected note imposes),
 * never per note — clamping each note independently would silently collapse a
 * chord onto pitch 0 or tick 0.
 */
export function clampNoteDelta(notes: readonly { start: number; pitch: number }[], delta: NoteDelta): NoteDelta {
  if (notes.length === 0) return { ticks: 0, pitch: 0 };
  let minStart = Number.POSITIVE_INFINITY;
  let minPitch = Number.POSITIVE_INFINITY;
  let maxPitch = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note.start < minStart) minStart = note.start;
    if (note.pitch < minPitch) minPitch = note.pitch;
    if (note.pitch > maxPitch) maxPitch = note.pitch;
  }
  const ticks = Math.max(tick(delta.ticks), -minStart);
  const rawPitch = tick(delta.pitch);
  const pitch = Math.min(Math.max(rawPitch, -minPitch), 127 - maxPitch);
  return { ticks, pitch };
}

/** Row index of a channel in `channelOrder` (= its arrangement row, SS9). */
export function rowOfChannel(doc: DraftProject, channelId: ChannelId): number {
  return doc.channelOrder.indexOf(channelId);
}

/**
 * SS6: "moving a track is a one-field edit (`output`)" — so deleting a
 * channel must leave every survivor's `output` naming a channel that still
 * exists. Anything that fed a doomed channel now feeds what IT fed, walked
 * UP through the doomed set so a whole nested group branch collapses onto
 * the first surviving output rather than onto a dangling id.
 *
 * Must be called while the doomed channels are still in the document (the
 * walk reads their `output`) and with the doomed set COMPLETE — resolving one
 * hop at a time inside a loop over the doomed channels would make the result
 * depend on the order the caller happened to list them in, and could leave a
 * survivor pointing at a channel deleted later in the same command. A stale
 * `output` survives the session and the save file, where the codec repairs it
 * to `null` — i.e. a permanent, silent master bypass.
 */
export function repointSurvivingOutputs(doc: DraftProject, doomed: ReadonlySet<ChannelId>): void {
  if (doomed.size === 0) return;
  const fallback = findMasterChannelId(doc) ?? null;
  const survivingOutput = (from: ChannelId | null): ChannelId | null => {
    let cursor = from;
    const seen = new Set<ChannelId>(); // a pre-existing output cycle must not hang the walk
    while (cursor !== null && doomed.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = doc.channels[cursor]?.output ?? null;
    }
    return cursor ?? fallback;
  };
  for (const channel of Object.values(doc.channels)) {
    if (doomed.has(channel.id)) continue;
    if (channel.output !== null && doomed.has(channel.output)) {
      channel.output = survivingOutput(channel.output);
    }
  }
}

/**
 * Largest |delta| <= |wanted| (same sign) for which `isValid` holds for every
 * clip. Used by clip moves: a drag that would push one clip past the top of
 * the arrangement drags the whole selection as far as it legally goes instead
 * of tearing it apart.
 */
export function clampRowDelta(wanted: number, isValid: (delta: number) => boolean): number {
  const step = wanted < 0 ? 1 : -1;
  let delta = tick(wanted);
  while (delta !== 0 && !isValid(delta)) delta += step;
  return isValid(delta) ? delta : 0;
}

/** A plain (non-draft) deep copy of a note with a new id. */
export function copyNote(note: DraftNote | Note, id: NoteId): Note {
  const copy: Note = { id, start: note.start, dur: note.dur, pitch: note.pitch, vel: note.vel };
  if (note.muted === true) copy.muted = true;
  return copy;
}

/**
 * Invariant 8: absent optional data is an absent key, never `undefined`.
 * `muted` is the one optional flag notes carry, so it is written only when
 * true and deleted otherwise — which also keeps the encoder's output stable.
 */
export function setNoteMuted(note: DraftNote, muted: boolean): void {
  if (muted) note.muted = true;
  else if (note.muted !== undefined) delete note.muted;
}
