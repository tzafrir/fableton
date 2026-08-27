// SS10 FSM rows `DragMove` and `DragDup`.
//
//   | DragMove | body      | ghosts at snapped dtick/dpitch; audition on pitch
//   |          |           | change | one command: move n notes | revert |
//   | DragDup  | Alt+body  | ghosts of copies | one command: duplicate+move |
//   |          |           | revert |
//
// Snapping is RELATIVE (SS10): the DELTA is snapped, so a note that sat off
// grid stays off grid by the same amount. `Alt` bypasses snap — except in
// `DragDup`, where `Alt` is the modifier that SELECTED the verb and is
// therefore consumed by it (otherwise no duplicate drag could ever snap).
//
// SS10 also lists a second `Alt`+body verb in its hit-zone table: "`Alt`
// +vertical-drag on SELECTED note bodies adjusts velocity without leaving the
// grid". The spec's own qualifier is what separates the two verbs: the
// velocity sub-mode is offered only when the grabbed note was ALREADY
// selected, and on an unselected note `Alt`+body is unambiguously `DragDup`.
// When it is offered, the two are disambiguated by the dominant axis of the
// first promoted move and then LOCKED for the rest of the gesture:
// mostly-vertical = velocity, anything else = duplicate.

import type { DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import type { Command, NoteVelocityEdit } from "../../types/commands";
import type { ClickInfo } from "../../types/gesture";
import { applySelectionClick } from "../kit/selection";
import { snapMoveDelta } from "../kit/snapping";
import type { ContextRef } from "./context";
import {
  auditionPitchChange,
  clampGroupDelta,
  dragTargets,
  ghostOf,
  idsOf,
  stopAudition,
} from "./dragCommon";
import type { PianoRollHit, PianoRollNoteHit } from "./hits";
import { clampVelocity, pitchDeltaOfRows, VELOCITY_DRAG_RANGE_PX, type RONote } from "./layout";
import { HANDLER_IDS, type DupPreview, type GhostNote, type MovePreview } from "./preview";

function anchorOf(start: GestureStart<PianoRollHit>): PianoRollNoteHit {
  return start.hit as PianoRollNoteHit;
}

/** The gesture's notes, re-read from the document each frame by id. */
function notesOf(ref: ContextRef, ids: readonly string[]): RONote[] {
  const ctx = ref();
  const out: RONote[] = [];
  for (const id of ids) {
    const note = ctx.noteById(id);
    if (note !== undefined) out.push(note);
  }
  return out;
}

// --- DragMove ---------------------------------------------------------------

export function createMoveDragHandler(ref: ContextRef): DragHandler<PianoRollHit, MovePreview> {
  // SS10's `Esc` column for this row is "revert", and the gesture's FIRST act
  // is a selection change (`begin` below) — so the abort has to put the
  // selection back too, or a cancelled drag still leaves a visible edit. The
  // marquee row already works this way (`dragMarquee.base`).
  let baseSelection: readonly string[] = [];

  return {
    id: HANDLER_IDS.move,
    priority: 10,
    cursor: "move",

    claim(start: GestureStart<PianoRollHit>): boolean {
      return (
        start.button === 0 &&
        start.hit.kind === "note-body" &&
        !start.modifiers.alt &&
        ref().clipId !== null
      );
    },

    begin(start: GestureStart<PianoRollHit>): MovePreview {
      const ctx = ref();
      const hit = anchorOf(start);
      // A drag on an unselected note selects it first, so the gesture and the
      // keyboard always act on the same set (SS10's selection-centric map).
      baseSelection = ctx.selection.ids();
      applySelectionClick(ctx.selection, hit.noteId, start.modifiers, { keepGroup: true });
      const targets = dragTargets(ctx, hit.noteId);
      return {
        kind: "move",
        noteIds: idsOf(targets),
        deltaTicks: 0,
        deltaPitch: 0,
        ghosts: targets.map((note) => ghostOf(note, 0, 0)),
        auditionPitch: null,
      };
    },

    update(update: DragUpdate<PianoRollHit, MovePreview>): MovePreview {
      const ctx = ref();
      const targets = notesOf(ref, update.preview.noteIds);
      const snapped = snapMoveDelta(update.grid, update.deltaTicks, update.modifiers);
      const delta = clampGroupDelta(targets, snapped, pitchDeltaOfRows(update.deltaRows));
      const anchor = anchorOf(update.start);
      // SS10: "audition on pitch change" — silent while the transpose is 0.
      const nextPitch = delta.pitch === 0 ? null : anchor.note.pitch + delta.pitch;
      const auditionPitch = auditionPitchChange(
        ctx,
        update.preview.auditionPitch,
        nextPitch,
        anchor.note.vel,
      );
      return {
        kind: "move",
        noteIds: update.preview.noteIds,
        deltaTicks: delta.ticks,
        deltaPitch: delta.pitch,
        ghosts: targets.map((note) => ghostOf(note, delta.ticks, delta.pitch)),
        auditionPitch,
      };
    },

    commit(update: DragUpdate<PianoRollHit, MovePreview>): Command | null {
      const ctx = ref();
      const preview = update.preview;
      stopAudition(ctx, preview.auditionPitch);
      const clipId = ctx.clipId;
      if (clipId === null) return null;
      if (preview.deltaTicks === 0 && preview.deltaPitch === 0) return null;
      if (preview.noteIds.length === 0) return null;
      return ctx.commands.moveNotes(clipId, preview.noteIds, {
        ticks: preview.deltaTicks,
        pitch: preview.deltaPitch,
      });
    },

    cancel(preview: MovePreview): void {
      // "Esc aborts with ZERO document traffic" — the audition stops and the
      // selection `begin` replaced goes back.
      const ctx = ref();
      stopAudition(ctx, preview.auditionPitch);
      ctx.selection.set(baseSelection);
    },

    click(start: GestureStart<PianoRollHit>, info: ClickInfo): Command | null {
      applySelectionClick(ref().selection, anchorOf(start).noteId, info.modifiers);
      return null;
    },
  };
}

// --- DragDup (+ the Alt+vertical velocity sub-mode) --------------------------

function velocityEdits(targets: readonly RONote[], deltaVel: number): NoteVelocityEdit[] {
  return targets.map((note) => ({ id: note.id, vel: clampVelocity(note.vel + deltaVel) }));
}

function velocityGhosts(
  targets: readonly RONote[],
  edits: readonly NoteVelocityEdit[],
): GhostNote[] {
  return targets.map((note, i) => ({
    id: note.id,
    start: note.start,
    dur: note.dur,
    pitch: note.pitch,
    vel: edits[i]?.vel ?? note.vel,
  }));
}

export function createDupDragHandler(ref: ContextRef): DragHandler<PianoRollHit, DupPreview> {
  /** As in `createMoveDragHandler`: `Esc` reverts the selection too. */
  let baseSelection: readonly string[] = [];

  return {
    id: HANDLER_IDS.dup,
    // Above `DragMove`: both claim a body, `Alt` decides which.
    priority: 20,
    cursor: "copy",

    claim(start: GestureStart<PianoRollHit>): boolean {
      return (
        start.button === 0 &&
        start.hit.kind === "note-body" &&
        start.modifiers.alt &&
        ref().clipId !== null
      );
    },

    begin(start: GestureStart<PianoRollHit>): DupPreview {
      const ctx = ref();
      const hit = anchorOf(start);
      // Read BEFORE the click selects it: SS10 scopes the velocity sub-mode
      // to note bodies that were already selected.
      const velocityAllowed = ctx.selection.has(hit.noteId);
      baseSelection = ctx.selection.ids();
      applySelectionClick(ctx.selection, hit.noteId, start.modifiers, { keepGroup: true });
      const targets = dragTargets(ctx, hit.noteId);
      return {
        kind: "dup",
        mode: "duplicate",
        locked: false,
        velocityAllowed,
        noteIds: idsOf(targets),
        deltaTicks: 0,
        deltaPitch: 0,
        velocities: [],
        ghosts: targets.map((note) => ({ ...ghostOf(note, 0, 0), id: null })),
        auditionPitch: null,
      };
    },

    update(update: DragUpdate<PianoRollHit, DupPreview>): DupPreview {
      const ctx = ref();
      const previous = update.preview;
      const targets = notesOf(ref, previous.noteIds);
      const mode: DupPreview["mode"] = previous.locked
        ? previous.mode
        : previous.velocityAllowed && Math.abs(update.deltaPx.y) > Math.abs(update.deltaPx.x)
          ? "velocity"
          : "duplicate";

      if (mode === "velocity") {
        const deltaVel = Math.round((-update.deltaPx.y * 126) / VELOCITY_DRAG_RANGE_PX);
        const edits = velocityEdits(targets, deltaVel);
        stopAudition(ctx, previous.auditionPitch);
        return {
          kind: "dup",
          mode,
          locked: true,
          velocityAllowed: previous.velocityAllowed,
          noteIds: previous.noteIds,
          deltaTicks: 0,
          deltaPitch: 0,
          velocities: edits,
          ghosts: velocityGhosts(targets, edits),
          auditionPitch: null,
        };
      }

      // `Alt` is consumed as the duplicate modifier here, so it does NOT also
      // bypass snapping (see the file header).
      const snapped = update.grid.snapDelta(update.deltaTicks);
      const delta = clampGroupDelta(targets, snapped, pitchDeltaOfRows(update.deltaRows));
      const anchor = anchorOf(update.start);
      const nextPitch = delta.pitch === 0 ? null : anchor.note.pitch + delta.pitch;
      const auditionPitch = auditionPitchChange(
        ctx,
        previous.auditionPitch,
        nextPitch,
        anchor.note.vel,
      );
      return {
        kind: "dup",
        mode,
        locked: true,
        velocityAllowed: previous.velocityAllowed,
        noteIds: previous.noteIds,
        deltaTicks: delta.ticks,
        deltaPitch: delta.pitch,
        velocities: [],
        ghosts: targets.map((note) => ({
          ...ghostOf(note, delta.ticks, delta.pitch),
          id: null,
        })),
        auditionPitch,
      };
    },

    commit(update: DragUpdate<PianoRollHit, DupPreview>): Command | null {
      const ctx = ref();
      const preview = update.preview;
      stopAudition(ctx, preview.auditionPitch);
      const clipId = ctx.clipId;
      if (clipId === null || preview.noteIds.length === 0) return null;

      if (preview.mode === "velocity") {
        const changed = preview.velocities.filter(
          (edit) => ctx.noteById(edit.id)?.vel !== edit.vel,
        );
        return changed.length === 0 ? null : ctx.commands.setNoteVelocities(clipId, changed);
      }

      if (preview.deltaTicks === 0 && preview.deltaPitch === 0) return null;
      return ctx.commands.duplicateNotes(clipId, preview.noteIds, {
        ticks: preview.deltaTicks,
        pitch: preview.deltaPitch,
      });
    },

    cancel(preview: DupPreview): void {
      const ctx = ref();
      stopAudition(ctx, preview.auditionPitch);
      ctx.selection.set(baseSelection);
    },

    click(start: GestureStart<PianoRollHit>, info: ClickInfo): Command | null {
      applySelectionClick(ref().selection, anchorOf(start).noteId, info.modifiers);
      return null;
    },
  };
}
