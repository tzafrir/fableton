// SS10 FSM row `DragVel`, and the hit-zone line it implements:
//
//   "Velocity lane (bottom strip): each note draws a stalk; drag sets
//    velocity, marquee-drag sets many"
//   | DragVel | velocity stalk | set velocity for stalks in x-range | one
//   | command | revert |
//
// The x-range IS the "marquee-drag sets many" half: the gesture sweeps from
// the pointerdown x to the current x and every stalk in between takes the
// velocity the pointer's y encodes. The stalk grabbed at pointerdown is always
// included, so a straight vertical drag edits exactly one note.
//
// Threshold 0: a plain click in the lane is already a velocity edit, which is
// what makes the lane feel like a lane and not like a widget.

import type { Command, NoteVelocityEdit } from "../../types/commands";
import type { DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import type { NoteId } from "../../types/ids";
import type { ContextRef, PianoRollContext } from "./context";
import type { PianoRollHit, PianoRollNoteHit } from "./hits";
import { stalkX, velocityAtY } from "./layout";
import { HANDLER_IDS, type VelocityPreview } from "./preview";

function sweepEdits(
  ctx: PianoRollContext,
  fromPx: number,
  toPx: number,
  vel: number,
  alwaysInclude: NoteId | null,
): NoteVelocityEdit[] {
  const out: NoteVelocityEdit[] = [];
  for (const note of ctx.notes()) {
    const x = stalkX(ctx.viewport, note);
    if ((x >= fromPx && x <= toPx) || note.id === alwaysInclude) {
      out.push({ id: note.id, vel });
    }
  }
  return out;
}

export function createVelocityDragHandler(
  ref: ContextRef,
): DragHandler<PianoRollHit, VelocityPreview> {
  return {
    id: HANDLER_IDS.velocity,
    priority: 10,
    cursor: "ns-resize",
    // The lane responds to the press itself, not to 3 px of travel.
    thresholdPx: 0,

    claim(start: GestureStart<PianoRollHit>): boolean {
      return (
        start.button === 0 &&
        (start.hit.kind === "velocity-stalk" || start.hit.kind === "velocity-lane") &&
        ref().clipId !== null
      );
    },

    begin(start: GestureStart<PianoRollHit>): VelocityPreview {
      const ctx = ref();
      const vel = velocityAtY(ctx.layout, start.point.yPx);
      const anchor =
        start.hit.kind === "velocity-stalk" ? (start.hit as PianoRollNoteHit).noteId : null;
      const x = start.point.xPx;
      return {
        kind: "velocity",
        edits: sweepEdits(ctx, x, x, vel, anchor),
        vel,
        fromPx: x,
        toPx: x,
      };
    },

    update(update: DragUpdate<PianoRollHit, VelocityPreview>): VelocityPreview {
      const ctx = ref();
      const vel = velocityAtY(ctx.layout, update.point.yPx);
      const fromPx = Math.min(update.start.point.xPx, update.point.xPx);
      const toPx = Math.max(update.start.point.xPx, update.point.xPx);
      const anchor =
        update.start.hit.kind === "velocity-stalk"
          ? (update.start.hit as PianoRollNoteHit).noteId
          : null;
      return {
        kind: "velocity",
        edits: sweepEdits(ctx, fromPx, toPx, vel, anchor),
        vel,
        fromPx,
        toPx,
      };
    },

    commit(update: DragUpdate<PianoRollHit, VelocityPreview>): Command | null {
      const ctx = ref();
      const clipId = ctx.clipId;
      if (clipId === null) return null;
      const changed = update.preview.edits.filter(
        (edit) => ctx.noteById(edit.id)?.vel !== edit.vel,
      );
      if (changed.length === 0) return null;
      return ctx.commands.setNoteVelocities(clipId, changed);
    },

    cancel(): void {
      // Preview-only, like every other row: nothing to revert.
    },
  };
}
