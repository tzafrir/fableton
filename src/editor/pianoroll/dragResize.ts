// SS10 FSM rows `DragResizeL` / `DragResizeR`:
//
//   | DragResizeL/R | edge | ghost lengths; floor = 1/128 note | one command:
//   | resize | revert |
//
// SS10 "Snapping": "Resize snaps the moving edge, never the anchored one." The
// kit's contract fixes HOW: `Grid.snapDelta` is documented as "every
// move/RESIZE drag", so the DELTA of the moving edge is snapped (off-grid
// notes keep their offset) and the anchored edge is never recomputed at all.
// `Alt` bypasses snap, via the kit's `snapMoveDelta`.

import type { Command, NoteSpan } from "../../types/commands";
import type { ClickInfo, DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import { MIN_NOTE_TICKS } from "../../types/editor";
import { applySelectionClick } from "../kit/selection";
import { snapMoveDelta } from "../kit/snapping";
import type { ContextRef } from "./context";
import { dragTargets } from "./dragCommon";
import type { PianoRollHit, PianoRollNoteHit } from "./hits";
import type { RONote } from "./layout";
import { HANDLER_IDS, type GhostNote, type ResizePreview } from "./preview";

export type ResizeEdge = "l" | "r";

/** One note's new span for a given edge and (already snapped) delta. */
export function resizedSpan(note: RONote, edge: ResizeEdge, deltaTicks: number): NoteSpan {
  const end = note.start + note.dur;
  if (edge === "r") {
    const dur = Math.max(MIN_NOTE_TICKS, note.dur + deltaTicks);
    return { id: note.id, start: note.start, dur };
  }
  // Left edge: the RIGHT edge is the anchor and must not move, so the new
  // start is clamped to [0, end - floor].
  const start = Math.min(Math.max(0, note.start + deltaTicks), end - MIN_NOTE_TICKS);
  return { id: note.id, start, dur: end - start };
}

function ghostOfSpan(note: RONote, span: NoteSpan): GhostNote {
  return { id: note.id, start: span.start, dur: span.dur, pitch: note.pitch, vel: note.vel };
}

export function createResizeDragHandler(
  ref: ContextRef,
  edge: ResizeEdge,
): DragHandler<PianoRollHit, ResizePreview> {
  const zone = edge === "l" ? "note-edge-l" : "note-edge-r";
  /** As in `dragMove`: SS10's `Esc` = "revert", including the selection this
   *  gesture replaced in `begin`. */
  let baseSelection: readonly string[] = [];

  return {
    id: edge === "l" ? HANDLER_IDS.resizeL : HANDLER_IDS.resizeR,
    priority: 30,
    cursor: "ew-resize",

    claim(start: GestureStart<PianoRollHit>): boolean {
      return start.button === 0 && start.hit.kind === zone && ref().clipId !== null;
    },

    begin(start: GestureStart<PianoRollHit>): ResizePreview {
      const ctx = ref();
      const hit = start.hit as PianoRollNoteHit;
      baseSelection = ctx.selection.ids();
      applySelectionClick(ctx.selection, hit.noteId, start.modifiers, { keepGroup: true });
      const targets = dragTargets(ctx, hit.noteId);
      const spans = targets.map((note) => resizedSpan(note, edge, 0));
      return {
        kind: "resize",
        edge,
        spans,
        ghosts: targets.map((note, i) => ghostOfSpan(note, spans[i] as NoteSpan)),
      };
    },

    update(update: DragUpdate<PianoRollHit, ResizePreview>): ResizePreview {
      const ctx = ref();
      const delta = snapMoveDelta(update.grid, update.deltaTicks, update.modifiers);
      const targets: RONote[] = [];
      for (const span of update.preview.spans) {
        const note = ctx.noteById(span.id);
        if (note !== undefined) targets.push(note);
      }
      const spans = targets.map((note) => resizedSpan(note, edge, delta));
      return {
        kind: "resize",
        edge,
        spans,
        ghosts: targets.map((note, i) => ghostOfSpan(note, spans[i] as NoteSpan)),
      };
    },

    commit(update: DragUpdate<PianoRollHit, ResizePreview>): Command | null {
      const ctx = ref();
      const clipId = ctx.clipId;
      if (clipId === null) return null;
      const changed = update.preview.spans.filter((span) => {
        const note = ctx.noteById(span.id);
        return note !== undefined && (note.start !== span.start || note.dur !== span.dur);
      });
      if (changed.length === 0) return null;
      return ctx.commands.resizeNotes(clipId, changed);
    },

    cancel(): void {
      // Nothing to undo: the drag only ever touched the preview — except the
      // selection `begin` replaced, which goes back.
      ref().selection.set(baseSelection);
    },

    click(start: GestureStart<PianoRollHit>, info: ClickInfo): Command | null {
      applySelectionClick(ref().selection, (start.hit as PianoRollNoteHit).noteId, info.modifiers);
      return null;
    },
  };
}

/** Both edges, in the order the engine should try them (order is irrelevant:
 *  their claims are disjoint zones). */
export function createResizeDragHandlers(
  ref: ContextRef,
): readonly [DragHandler<PianoRollHit, ResizePreview>, DragHandler<PianoRollHit, ResizePreview>] {
  return [createResizeDragHandler(ref, "l"), createResizeDragHandler(ref, "r")];
}
