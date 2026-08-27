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
import { pitchAtY, yOfPitch, type RONote } from "./layout";
import { HANDLER_IDS, type MarqueePreview, type RectPx } from "./preview";

function normalizedRect(x0: number, y0: number, x1: number, y1: number): RectPx {
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  };
}

/** Reused across marquee frames: `update` runs on every pointermove. */
const CANDIDATES: RONote[] = [];

/** Notes whose rectangle intersects the marquee, in document order.
 *
 *  SS9's culling rule, on the gesture path: the horizontal span of the
 *  rectangle is a tick range, so the candidates come from the context's
 *  binary-searched index instead of a walk over the whole clip on every
 *  pointermove. */
export function notesInRect(ctx: PianoRollContext, rect: RectPx): NoteId[] {
  const { viewport, layout } = ctx;
  const out: NoteId[] = [];
  CANDIDATES.length = 0;
  // A note is at least 1 px wide on screen, so widen the query by that much
  // before converting back to ticks.
  const pad = Math.ceil(1 / Math.max(viewport.pxPerTick, 1e-9));
  const from = viewport.tAt(rect.x0) - pad;
  const to = viewport.tAt(rect.x1) + pad + 1;
  for (const note of ctx.notesInRange(from, to, CANDIDATES)) {
    const x = viewport.xOf(note.start);
    const right = x + Math.max(note.dur * viewport.pxPerTick, 1);
    if (right < rect.x0 || x > rect.x1) continue;
    const y = yOfPitch(viewport, layout, note.pitch);
    if (y + viewport.pxPerRow < rect.y0 || y > rect.y1) continue;
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
      // SS10 `Pending`: "click: select (`Shift` adds, `Ctrl` toggles)". Only a
      // PLAIN click on empty grid clears — a Shift/Ctrl click that missed a
      // note by a pixel must leave the additive selection alone, exactly as
      // `begin` above preserves it for a modified marquee drag.
      if (!info.modifiers.shift && !info.modifiers.primary) ctx.selection.clear();
      return null;
    },
  };
}
