// Clip creation (SS18-M1 "clip create ... as FSM verbs, each drag = ghost
// preview + exactly one command").
//
// The arrangement's empty-lane gestures, mirroring SS10's piano-roll table
// ("Empty grid — marquee ... or note creation ... / double-click"):
//
//   drag on an empty TRACK lane      -> create a clip spanning the drag
//   double-click on an empty lane    -> create a one-bar clip there
//   click on an empty lane           -> clear the selection
//   Shift / Cmd-Ctrl + drag          -> marquee (./dragMarquee.ts claims it)
//
// Creation is the one place SS10 asks for ABSOLUTE snapping ("absolute snap
// applies only when creating"), and `Alt` still bypasses it.

import type { Command } from "../../types/commands";
import type { ClickInfo, DragHandler, DragUpdate, GestureStart, Modifiers } from "../../types/gesture";
import type { LayerFrame } from "../../types/render";
import type { ChannelId } from "../../types/ids";
import type { Ticks } from "../../types/time";
import { ticksPerBar } from "../../time";
import { snapCreateTick } from "../kit";
import type { ArrangementTheme } from "./constants";
import type { ArrangementContext } from "./context";
import type { ClipGhost } from "./edits";
import { createSpan } from "./edits";
import { drawGhosts } from "./ghosts";
import type { ArrangementHit } from "./hits";

export interface CreatePreview {
  readonly trackId: ChannelId | null;
  readonly row: number;
  readonly start: Ticks;
  readonly length: Ticks;
  readonly ghosts: readonly ClipGhost[];
}

export const CREATE_HANDLER_ID = "arrangement.create";

export function createCreateDragHandler(
  context: ArrangementContext,
  theme: ArrangementTheme,
): DragHandler<ArrangementHit, CreatePreview> {
  const previewOf = (
    start: GestureStart<ArrangementHit>,
    pointerTick: Ticks,
    mods: Modifiers,
  ): CreatePreview => {
    const hit = start.hit;
    const row = hit.kind === "lane" ? hit.row : 0;
    const trackId = hit.kind === "lane" ? hit.channelId : null;
    const span = createSpan(
      start.point.tick,
      pointerTick,
      (tick) => snapCreateTick(start.grid, tick, mods, "floor"),
      (tick) => snapCreateTick(start.grid, tick, mods, "ceil"),
      start.grid.gridTicks(),
    );
    return {
      trackId,
      row,
      start: span.start,
      length: span.length,
      ghosts: [
        {
          clipId: "",
          row,
          start: span.start,
          length: span.length,
          loop: null,
          label: trackId === null ? "" : (context.scene.doc.channels[trackId]?.name ?? ""),
        },
      ],
    };
  };

  return {
    id: CREATE_HANDLER_ID,
    priority: 5,
    cursor: "crosshair",

    claim(start: GestureStart<ArrangementHit>): boolean {
      if (start.button !== 0 || start.hit.kind !== "lane") return false;
      if (!start.hit.isTrack || start.hit.channelId === null) return false;
      // Shift / primary on an empty lane means "marquee", not "create".
      return !start.modifiers.shift && !start.modifiers.primary;
    },

    begin(start: GestureStart<ArrangementHit>): CreatePreview {
      return previewOf(start, start.point.tick, start.modifiers);
    },

    update(update: DragUpdate<ArrangementHit, CreatePreview>): CreatePreview {
      // LIVE modifiers: pressing Alt mid-drag drops snapping immediately.
      return previewOf(update.start, update.point.tick, update.modifiers);
    },

    commit(update: DragUpdate<ArrangementHit, CreatePreview>): Command | null {
      const { trackId, start, length } = update.preview;
      if (trackId === null) return null;
      context.selectCreatedClips();
      return context.commands.createClip({ trackId, start, length });
    },

    cancel(): void {
      // No document traffic — the ghost rectangle just disappears.
    },

    click(start: GestureStart<ArrangementHit>, info: ClickInfo): Command | null {
      const hit = start.hit;
      if (hit.kind !== "lane") return null;
      if (info.clickCount >= 2 && hit.isTrack && hit.channelId !== null) {
        // SS10's "dbl-click empty: create grid-length note", clip flavour: a
        // bar is the useful unit here (a 1/16 clip would be unusable), and it
        // matches the one-bar clip a fresh project ships with.
        const bar = ticksPerBar(context.scene.doc.timeSignature);
        const tick = snapCreateTick(start.grid, start.point.tick, info.modifiers, "floor");
        context.selectCreatedClips();
        return context.commands.createClip({
          trackId: hit.channelId,
          start: Math.max(0, tick),
          length: bar,
        });
      }
      if (!info.modifiers.shift && !info.modifiers.primary) context.selection.clear();
      return null;
    },

    drawPreview(frame: LayerFrame, preview: CreatePreview): void {
      drawGhosts(frame, theme, preview.ghosts);
    },
  };
}
