// SS10's `Marquee`: "live rect-intersect selection ... commit selection (not
// undoable)". The one verb whose `commit` returns `null` by design (SS9:
// "`commit` returns the ONE command ... or `null` when the gesture is not a
// document edit").
//
// Entered by `Shift`/`Cmd-Ctrl`+drag on a lane (plain drag there creates a
// clip), and by a plain drag on a non-track lane, which has nothing to create.

import type { Command } from "../../types/commands";
import type { ClipId } from "../../types/ids";
import type { ClickInfo, DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import type { LayerFrame } from "../../types/render";
import type { Ticks } from "../../types/time";
import type { ArrangementTheme } from "./constants";
import type { ArrangementContext } from "./context";
import { drawMarquee } from "./ghosts";
import type { ArrangementHit } from "./hits";

export interface MarqueePreview {
  readonly fromTick: Ticks;
  readonly toTick: Ticks;
  readonly fromRow: number;
  readonly toRow: number;
  /** The selection as it was when the marquee started (`Shift` adds to it). */
  readonly base: readonly ClipId[];
  readonly hits: readonly ClipId[];
}

export const MARQUEE_HANDLER_ID = "arrangement.marquee";

export function createMarqueeDragHandler(
  context: ArrangementContext,
  theme: ArrangementTheme,
): DragHandler<ArrangementHit, MarqueePreview> {
  const apply = (
    base: readonly ClipId[],
    hits: readonly ClipId[],
    modifiers: { shift: boolean; primary: boolean },
  ): void => {
    if (modifiers.shift) {
      context.selection.set([...base, ...hits]);
      return;
    }
    if (modifiers.primary) {
      // Toggle: members of `base` that the marquee covers drop out.
      const covered = new Set(hits);
      const next = base.filter((id) => !covered.has(id));
      for (const id of hits) if (!base.includes(id)) next.push(id);
      context.selection.set(next);
      return;
    }
    context.selection.set(hits);
  };

  return {
    id: MARQUEE_HANDLER_ID,
    priority: 1,
    cursor: "crosshair",

    claim(start: GestureStart<ArrangementHit>): boolean {
      if (start.button !== 0 || start.hit.kind !== "lane") return false;
      return start.modifiers.shift || start.modifiers.primary || !start.hit.isTrack;
    },

    begin(start: GestureStart<ArrangementHit>): MarqueePreview {
      return {
        fromTick: start.point.tick,
        toTick: start.point.tick,
        fromRow: start.point.row,
        toRow: start.point.row,
        base: context.selection.ids(),
        hits: [],
      };
    },

    update(update: DragUpdate<ArrangementHit, MarqueePreview>): MarqueePreview {
      const { base, fromTick, fromRow } = update.preview;
      const toTick = update.point.tick;
      const toRow = update.point.row;
      const hits = context.scene
        .clipsIntersecting(
          Math.floor(Math.min(fromRow, toRow)),
          Math.floor(Math.max(fromRow, toRow)),
          Math.min(fromTick, toTick),
          Math.max(fromTick, toTick),
        )
        .map((clip) => clip.id);
      apply(base, hits, update.modifiers);
      return { fromTick, toTick, fromRow, toRow, base, hits };
    },

    commit(): Command | null {
      // Selection is ephemeral (SS13): nothing to dispatch, nothing to undo.
      return null;
    },

    cancel(preview: MarqueePreview): void {
      context.selection.set(preview.base);
    },

    click(_start: GestureStart<ArrangementHit>, info: ClickInfo): Command | null {
      // SS10 `Pending`: "click: select (`Shift` adds, `Ctrl` toggles)". This
      // handler claims Shift/Ctrl presses on a lane, so an ADDITIVE click that
      // merely missed a clip must leave the selection alone — clearing it
      // would throw away exactly what the user was adding to. Both siblings
      // guard the same case (`dragCreate.click`, `pianoroll/dragMarquee`).
      if (!info.modifiers.shift && !info.modifiers.primary) context.selection.clear();
      return null;
    },

    drawPreview(frame: LayerFrame, preview: MarqueePreview): void {
      drawMarquee(frame, theme, preview.fromTick, preview.toTick, preview.fromRow, preview.toRow);
    },
  };
}
