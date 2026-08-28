// Clip loop brace editing (SS10's `MidiClip.loop`, "the region the player
// unrolls repeatedly to fill `length`").
//
// The brace is a band along the top of a looped clip with a handle at each
// end. Dragging a handle moves that end; dragging between them slides the
// whole window. Bounds are CLIP-RELATIVE ticks, so the brace survives a clip
// move untouched. One `setClipLoop` command per gesture.

import type { Command } from "../../types/commands";
import type { ClickInfo, DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import type { LayerFrame } from "../../types/render";
import type { ClipId } from "../../types/ids";
import type { Ticks } from "../../types/time";
import { applySelectionClick, snapMoveDelta } from "../kit";
import type { ArrangementTheme } from "./constants";
import type { ArrangementContext } from "./context";
import type { ClipGhost } from "./edits";
import { loopAfterDrag } from "./edits";
import { drawGhosts } from "./ghosts";
import { loopOf } from "./geometry";
import type { ArrangementHit } from "./hits";

export type LoopPart = "loopStart" | "loopEnd" | "loopBody";

export interface LoopPreview {
  readonly clipId: ClipId;
  readonly part: LoopPart;
  readonly loop: { readonly start: Ticks; readonly end: Ticks } | null;
  readonly ghosts: readonly ClipGhost[];
}

export const LOOP_HANDLER_ID = "arrangement.loop";

function isLoopZone(hit: ArrangementHit): hit is Extract<ArrangementHit, { kind: "clip" }> {
  return (
    hit.kind === "clip" &&
    (hit.zone === "loopStart" || hit.zone === "loopEnd" || hit.zone === "loopBody")
  );
}

export function createLoopDragHandler(
  context: ArrangementContext,
  theme: ArrangementTheme,
): DragHandler<ArrangementHit, LoopPreview> {
  const previewOf = (start: GestureStart<ArrangementHit>, deltaTicks: Ticks): LoopPreview => {
    const hit = start.hit;
    if (!isLoopZone(hit)) {
      return { clipId: "", part: "loopBody", loop: null, ghosts: [] };
    }
    const part = hit.zone as LoopPart;
    const clip = context.scene.clip(hit.clipId);
    if (clip === undefined) return { clipId: hit.clipId, part, loop: null, ghosts: [] };
    const loop = loopAfterDrag(clip, part, deltaTicks);
    const row = context.scene.rowOfClip(clip.id);
    const ghost: ClipGhost = {
      clipId: clip.id,
      row: row < 0 ? 0 : row,
      start: clip.start,
      length: clip.length,
      loop,
      label: clip.name ?? "",
    };
    return { clipId: clip.id, part, loop, ghosts: [ghost] };
  };

  return {
    id: LOOP_HANDLER_ID,
    priority: 30,
    cursor: "col-resize",

    claim(start: GestureStart<ArrangementHit>): boolean {
      return start.button === 0 && isLoopZone(start.hit);
    },

    begin(start: GestureStart<ArrangementHit>): LoopPreview {
      return previewOf(start, 0);
    },

    update(update: DragUpdate<ArrangementHit, LoopPreview>): LoopPreview {
      return previewOf(update.start, snapMoveDelta(update.grid, update.deltaTicks, update.modifiers));
    },

    commit(update: DragUpdate<ArrangementHit, LoopPreview>): Command | null {
      const { clipId, loop } = update.preview;
      if (loop === null || clipId === "") return null;
      const clip = context.scene.clip(clipId);
      const current = clip === undefined ? null : loopOf(clip);
      if (current !== undefined && current !== null && current.start === loop.start && current.end === loop.end) {
        return null;
      }
      return context.commands.setClipLoop(clipId, { start: loop.start, end: loop.end });
    },

    cancel(): void {
      // The document never saw the drag.
    },

    click(start: GestureStart<ArrangementHit>, info: ClickInfo): Command | null {
      if (start.hit.kind !== "clip") return null;
      applySelectionClick(context.selection, start.hit.clipId, info.modifiers);
      return null;
    },

    drawPreview(frame: LayerFrame, preview: LoopPreview): void {
      drawGhosts(frame, theme, preview.ghosts);
    },
  };
}
