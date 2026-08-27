// SS10's `DragMove` / `DragDup`, arrangement flavour: drag a clip body to
// move the selection, `Cmd/Ctrl`+drag to duplicate it.
//
// One command per gesture, computed from the same ghosts the overlay drew:
//   move      -> `moveClips(ids, {ticks, tracks})`     (relative, SS10)
//   duplicate -> `duplicateClips(ids, {ticks, tracks})` (copy + move, one entry)
//
// `Alt` stays the snap bypass everywhere (kit `snapMoveDelta`), which is why
// duplicate is on `primary` and not on `Alt` in this editor.

import type { Command } from "../../types/commands";
import type { ClickInfo, DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import type { LayerFrame } from "../../types/render";
import type { Ticks } from "../../types/time";
import { applySelectionClick, snapMoveDelta } from "../kit";
import type { ArrangementContext } from "./context";
import type { ClipGhost } from "./edits";
import { clampMoveDelta, dragTargets, moveGhosts } from "./edits";
import type { ArrangementHit } from "./hits";
import type { ArrangementTheme } from "./constants";
import { drawGhosts } from "./ghosts";

export interface MovePreview {
  readonly ghosts: readonly ClipGhost[];
  readonly deltaTicks: Ticks;
  readonly deltaRows: number;
  readonly duplicate: boolean;
}

export const MOVE_HANDLER_ID = "arrangement.move";

export function createMoveDragHandler(
  context: ArrangementContext,
  theme: ArrangementTheme,
): DragHandler<ArrangementHit, MovePreview> {
  const targetsOf = (start: GestureStart<ArrangementHit>) =>
    start.hit.kind === "clip"
      ? dragTargets(context.scene, start.hit.clipId, context.selection.ids())
      : [];

  const previewOf = (
    start: GestureStart<ArrangementHit>,
    deltaTicks: Ticks,
    deltaRows: number,
    duplicate: boolean,
  ): MovePreview => {
    const clips = targetsOf(start);
    const clamped = clampMoveDelta(context.scene, clips, deltaTicks, deltaRows);
    return {
      ghosts: moveGhosts(context.scene, clips, clamped.ticks, clamped.rows),
      deltaTicks: clamped.ticks,
      deltaRows: clamped.rows,
      duplicate,
    };
  };

  return {
    id: MOVE_HANDLER_ID,
    priority: 10,
    cursor: "grabbing",

    claim(start: GestureStart<ArrangementHit>): boolean {
      return start.button === 0 && start.hit.kind === "clip" && start.hit.zone === "body";
    },

    begin(start: GestureStart<ArrangementHit>): MovePreview {
      if (start.hit.kind === "clip" && !context.selection.has(start.hit.clipId)) {
        // Dragging an unselected clip selects it first, so the ghosts and the
        // command agree with what the user sees highlighted.
        context.selection.set([start.hit.clipId]);
      }
      return previewOf(start, 0, 0, start.modifiers.primary);
    },

    update(update: DragUpdate<ArrangementHit, MovePreview>): MovePreview {
      const ticks = snapMoveDelta(update.grid, update.deltaTicks, update.modifiers);
      return previewOf(update.start, ticks, Math.round(update.deltaRows), update.preview.duplicate);
    },

    commit(update: DragUpdate<ArrangementHit, MovePreview>): Command | null {
      const { ghosts, deltaTicks, deltaRows, duplicate } = update.preview;
      if (ghosts.length === 0) return null;
      const ids = ghosts.map((ghost) => ghost.clipId);
      if (duplicate) {
        context.selectCreatedClips();
        return context.commands.duplicateClips(ids, { ticks: deltaTicks, tracks: deltaRows });
      }
      // A drag that ends where it started is not an edit: no command, no undo
      // entry (SS13 — one gesture, at most one entry).
      if (deltaTicks === 0 && deltaRows === 0) return null;
      return context.commands.moveClips(ids, { ticks: deltaTicks, tracks: deltaRows });
    },

    cancel(): void {
      // Zero document traffic (SS9): the ghosts simply disappear.
    },

    click(start: GestureStart<ArrangementHit>, info: ClickInfo): Command | null {
      if (start.hit.kind !== "clip") return null;
      if (info.clickCount >= 2) {
        // SS18-M1: double-click opens the piano roll on this clip.
        context.selection.set([start.hit.clipId]);
        context.openClip(start.hit.clipId);
        return null;
      }
      applySelectionClick(context.selection, start.hit.clipId, info.modifiers);
      return null;
    },

    drawPreview(frame: LayerFrame, preview: MovePreview): void {
      drawGhosts(frame, theme, preview.ghosts);
    },
  };
}
