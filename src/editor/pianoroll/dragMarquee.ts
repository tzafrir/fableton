// SS10 FSM row `Marquee`:
//
//   | Marquee | empty | live rect-intersect selection | commit selection (NOT
//   | undoable) | cancel |
//
// Selection is ephemeral (SS13), so this handler's `commit` returns `null`:
// the gesture changes no document state at all. `Esc` restores the selection
// the drag started from, which is the "cancel" column.
//
// The same handler owns SS10's `Pending` release on empty grid: a single click
// clears the selection, a double click "create[s a] grid-length note".

import type { Command } from "../../types/commands";
import type { ClickInfo, DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import type { NoteId } from "../../types/ids";
import { DEFAULT_NOTE_VELOCITY, MIN_NOTE_TICKS } from "../../types/editor";
import { snapCreateTick } from "../kit/snapping";
import type { ContextRef, PianoRollContext } from "./context";
import type { PianoRollHit } from "./hits";
import { noteRect, pitchAtY } from "./layout";
import { HANDLER_IDS, type MarqueePreview, type RectPx } from "./preview";

function normalizedRect(x0: number, y0: number, x1: number, y1: number): RectPx {
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  };
}

/** Notes whose rectangle intersects the marquee, in document order. */
export function notesInRect(ctx: PianoRollContext, rect: RectPx): NoteId[] {
  const out: NoteId[] = [];
  for (const note of ctx.notes()) {
    const r = noteRect(ctx.viewport, ctx.layout, note);
    const right = r.x + Math.max(r.w, 1);
    if (right < rect.x0 || r.x > rect.x1) continue;
    if (r.y + r.h < rect.y0 || r.y > rect.y1) continue;
    out.push(note.id);
  }
  return out;
}

/** `Shift` adds to the base selection, `Ctrl/Cmd` toggles, plain replaces. */
function applyMarqueeSelection(
  ctx: PianoRollContext,
  base: readonly NoteId[],
  hits: readonly NoteId[],
  start: GestureStart<PianoRollHit>,
): void {
  if (start.modifiers.shift) {
    ctx.selection.set([...base, ...hits]);
    return;
  }
  if (start.modifiers.primary) {
    const next = new Set(base);
    for (const id of hits) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    ctx.selection.set(next);
    return;
  }
  ctx.selection.set(hits);
}

export function createMarqueeDragHandler(
  ref: ContextRef,
): DragHandler<PianoRollHit, MarqueePreview> {
  return {
    id: HANDLER_IDS.marquee,
    priority: 0,
    cursor: "crosshair",

    claim(start: GestureStart<PianoRollHit>): boolean {
      return start.button === 0 && start.hit.kind === "grid";
    },

    begin(start: GestureStart<PianoRollHit>): MarqueePreview {
      const ctx = ref();
      const base = ctx.selection.ids();
      if (!start.modifiers.shift && !start.modifiers.primary) ctx.selection.clear();
      return {
        kind: "marquee",
        rect: normalizedRect(start.point.xPx, start.point.yPx, start.point.xPx, start.point.yPx),
        base,
        hits: [],
      };
    },

    update(update: DragUpdate<PianoRollHit, MarqueePreview>): MarqueePreview {
      const ctx = ref();
      const rect = normalizedRect(
        update.start.point.xPx,
        update.start.point.yPx,
        update.point.xPx,
        update.point.yPx,
      );
      const hits = notesInRect(ctx, rect);
      // "Live rect-intersect selection": the selection follows the rectangle
      // every frame, recomputed from the base so it can shrink again.
      applyMarqueeSelection(ctx, update.preview.base, hits, update.start);
      return { kind: "marquee", rect, base: update.preview.base, hits };
    },

    commit(): Command | null {
      // "Commit selection (not undoable)" — zero document traffic.
      return null;
    },

    cancel(preview: MarqueePreview): void {
      ref().selection.set(preview.base);
    },

    click(start: GestureStart<PianoRollHit>, info: ClickInfo): Command | null {
      const ctx = ref();
      const clipId = ctx.clipId;
      if (info.clickCount >= 2 && clipId !== null) {
        // SS10 `Pending`: "dbl-click empty: create grid-length note".
        // Creation is the ONE place snapping is ABSOLUTE (SS10 "Snapping").
        const start0 = snapCreateTick(ctx.grid, start.point.tick, info.modifiers, "floor");
        const dur = Math.max(MIN_NOTE_TICKS, ctx.grid.gridTicks());
        const pitch = pitchAtY(ctx.viewport, ctx.layout, start.point.yPx);
        return ctx.commands.addNotes(clipId, [
          { start: Math.max(0, start0), dur, pitch, vel: DEFAULT_NOTE_VELOCITY },
        ]);
      }
      ctx.selection.clear();
      return null;
    },
  };
}
