// SS11's verbs, one `DragHandler` each: "click a segment to add a point, drag
// a point (snap on time axis only), drag a segment's middle to bend `curve`,
// marquee + the same keyboard nudges."
//
// Every one of them is a pure function of the context plus the kit's synthetic
// gesture objects, so `fsm.test.ts` drives the real handlers headless (SS15).

import type {
  AutoPoint,
  ClickInfo,
  Command,
  DragHandler,
  DragUpdate,
  GestureStart,
  ParamDescriptor,
  Ticks,
} from "../../types";
import { snapBypassed } from "../kit/snapping";
import { segmentModeOf, type AutomationLaneContext } from "./context";
import type { LaneHit, PointHit, SegmentHit } from "./hits";
import { BEND_DRAG_RANGE_PX, valueAtY, yOfValue } from "./layout";
import { clampMoveDeltaTicks, earliestTick, segmentIndexAt, visiblePointRange } from "./points";

export interface MoveGhost {
  /** The point's tick at gesture start — its key for `moveLanePoints`. */
  fromT: Ticks;
  /** Its value at gesture start, so a frame needs no lookup in `points()`. */
  fromV: number;
  toT: Ticks;
  v: number;
}
export interface MovePreview {
  kind: "move";
  ghosts: MoveGhost[];
  /** Earliest `fromT` in the group — the left wall for the whole move. */
  earliestT: Ticks;
}
export interface BendPreview {
  kind: "bend";
  startT: Ticks;
  curve: number;
}
export interface MarqueePreview {
  kind: "marquee";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export type LanePreview = MovePreview | BendPreview | MarqueePreview;

export const HANDLER_IDS = {
  move: "automation.move",
  bend: "automation.bend",
  marquee: "automation.marquee",
} as const;

export function createAutomationDragHandlers(
  ctx: AutomationLaneContext,
): DragHandler<LaneHit, unknown>[] {
  /** The bend stored on the segment starting at `t` (0 when there is none).
   *  Binary-searched: the bend drag asks for it every frame. */
  const curveAt = (t: Ticks): number => {
    const pts = ctx.points();
    const point = pts[segmentIndexAt(pts, t)];
    return point !== undefined && point.t === t ? point.curve : 0;
  };

  // --- drag: move points ----------------------------------------------------

  const moveHandler: DragHandler<LaneHit, MovePreview> = {
    id: HANDLER_IDS.move,
    priority: 20,
    cursor: "grabbing",
    claim: (start) => start.button === 0 && start.hit.kind === "point",
    begin(start): MovePreview {
      const hit = start.hit as PointHit;
      if (!ctx.selection.has(hit.t)) {
        if (start.modifiers.shift) ctx.selection.add(hit.t);
        else ctx.selection.set([hit.t]);
      }
      const targets = ctx.points().filter((p) => ctx.selection.has(p.t));
      return {
        kind: "move",
        ghosts: targets.map((p) => ({ fromT: p.t, fromV: p.v, toT: p.t, v: p.v })),
        earliestT: earliestTick(targets),
      };
    },
    update(update): MovePreview {
      const desc = ctx.desc() as ParamDescriptor;
      const heightPx = ctx.heightPx();
      const snapped = snapBypassed(update.modifiers)
        ? update.deltaTicks
        : update.start.grid.snapDelta(update.deltaTicks);
      // SS10 "moves are relative": one clamped delta for the whole group, so
      // the shape survives a drag into the left wall (see `points.ts`).
      const deltaT = clampMoveDeltaTicks(snapped, update.preview.earliestT);
      const deltaY = update.point.yPx - update.start.point.yPx;
      const ghosts = update.preview.ghosts.map((g) => ({
        fromT: g.fromT,
        fromV: g.fromV,
        toT: g.fromT + deltaT,
        v: valueAtY(desc, yOfValue(desc, g.fromV, heightPx) + deltaY, heightPx),
      }));
      return { kind: "move", ghosts, earliestT: update.preview.earliestT };
    },
    commit(update): Command | null {
      const laneId = ctx.laneId();
      if (laneId === null) return null;
      const moved = update.preview.ghosts.filter((g) => g.fromT !== g.toT || g.v !== g.fromV);
      if (moved.length === 0) return null;
      ctx.selection.set(moved.map((g) => g.toT));
      return ctx.commands.moveLanePoints(laneId, moved);
    },
    cancel(): void {
      // Preview only — zero document traffic.
    },
    click(start: GestureStart<LaneHit>, info: ClickInfo): Command | null {
      const hit = start.hit as PointHit;
      const laneId = ctx.laneId();
      if (info.clickCount >= 2 && laneId !== null) {
        // Double-click a point: delete it (the fast way out).
        ctx.selection.remove(hit.t);
        return ctx.commands.deleteLanePoints(laneId, [hit.t]);
      }
      if (info.modifiers.shift) ctx.selection.toggle(hit.t);
      else ctx.selection.set([hit.t]);
      return null;
    },
  };

  // --- drag: bend a segment -------------------------------------------------

  const bendHandler: DragHandler<LaneHit, BendPreview> = {
    id: HANDLER_IDS.bend,
    priority: 10,
    cursor: "ns-resize",
    claim: (start) => start.button === 0 && start.hit.kind === "segment",
    begin(start): BendPreview {
      const hit = start.hit as SegmentHit;
      return { kind: "bend", startT: hit.startT, curve: curveAt(hit.startT) };
    },
    update(update: DragUpdate<LaneHit, BendPreview>): BendPreview {
      const hit = update.start.hit as SegmentHit;
      const base = curveAt(hit.startT);
      const desc = ctx.desc();
      // A discrete lane is a staircase: `curve` changes nothing about how it
      // draws, samples or sounds (curve.ts `'hold'`). Refusing the bend here —
      // rather than declining the claim — keeps the segment's click-to-add-a-
      // point alive, and stops the drag storing an invisible bend that would
      // reshape the lane the moment it was re-bound to a continuous param.
      if (desc !== null && segmentModeOf(desc) === "hold") {
        return { kind: "bend", startT: hit.startT, curve: base };
      }
      // Dragging DOWN eases in (positive bend) for a rising segment; keep the
      // simpler invariant: down = +curve.
      const curve = Math.min(1, Math.max(-1, base + update.deltaPx.y / (BEND_DRAG_RANGE_PX / 2)));
      return { kind: "bend", startT: hit.startT, curve };
    },
    commit(update): Command | null {
      const laneId = ctx.laneId();
      if (laneId === null) return null;
      if (update.preview.curve === curveAt(update.preview.startT)) return null;
      return ctx.commands.setLaneSegmentCurve(laneId, update.preview.startT, update.preview.curve);
    },
    cancel(): void {
      // Preview only.
    },
    click(start: GestureStart<LaneHit>): Command | null {
      // SS11: "click a segment to add a point".
      const laneId = ctx.laneId();
      const desc = ctx.desc();
      if (laneId === null || desc === null) return null;
      const t = Math.max(0, start.grid.snap(start.point.tick));
      const v = valueAtY(desc, start.point.yPx, ctx.heightPx());
      ctx.selection.set([t]);
      return ctx.commands.addLanePoint(laneId, { t, v });
    },
  };

  // --- drag: marquee on empty -----------------------------------------------

  // Claims BOTH empty space and the flat lead-in/trail-out: dragging either
  // marquee-selects, and only the click verb tells them apart (see `click`).
  const marqueeHandler: DragHandler<LaneHit, MarqueePreview> = {
    id: HANDLER_IDS.marquee,
    priority: 0,
    cursor: "crosshair",
    claim: (start) =>
      start.button === 0 && (start.hit.kind === "empty" || start.hit.kind === "flat"),
    begin(start): MarqueePreview {
      return {
        kind: "marquee",
        x0: start.point.xPx,
        y0: start.point.yPx,
        x1: start.point.xPx,
        y1: start.point.yPx,
      };
    },
    update(update): MarqueePreview {
      const next = { ...update.preview, x1: update.point.xPx, y1: update.point.yPx };
      const desc = ctx.desc();
      if (desc !== null) {
        const [x0, x1] = [Math.min(next.x0, next.x1), Math.max(next.x0, next.x1)];
        const [y0, y1] = [Math.min(next.y0, next.y1), Math.max(next.y0, next.y1)];
        const heightPx = ctx.heightPx();
        const pts = ctx.points();
        // Per-frame path: only the points inside the rectangle's TICK span can
        // be inside the rectangle (SS9's O(visible) rule applies to a gesture
        // running at frame rate just as it does to drawing).
        const range = visiblePointRange(pts, ctx.viewport.tAt(x0), ctx.viewport.tAt(x1));
        const inside: Ticks[] = [];
        for (let i = range.start; i < range.end; i++) {
          const pt = pts[i] as AutoPoint;
          const px = ctx.viewport.xOf(pt.t);
          const py = yOfValue(desc, pt.v, heightPx);
          if (px >= x0 && px <= x1 && py >= y0 && py <= y1) inside.push(pt.t);
        }
        ctx.selection.set(inside);
      }
      return next;
    },
    commit(): Command | null {
      return null; // selection is not undoable (SS10/SS13)
    },
    cancel(): void {
      ctx.selection.clear();
    },
    click(start: GestureStart<LaneHit>, info: ClickInfo): Command | null {
      // On the drawn curve's flat lead-in/trail-out a SINGLE click adds a
      // point, exactly as it does on a segment (SS11) — the line is drawn
      // there, so it has to answer the pointer. In genuinely empty space a
      // click clears and a DOUBLE-click adds, which is how an empty lane
      // gets its first point.
      const laneId = ctx.laneId();
      const desc = ctx.desc();
      const onCurve = start.hit.kind === "flat";
      if ((info.clickCount >= 2 || onCurve) && laneId !== null && desc !== null) {
        const t = Math.max(0, start.grid.snap(start.point.tick));
        const v = valueAtY(desc, start.point.yPx, ctx.heightPx());
        ctx.selection.set([t]);
        return ctx.commands.addLanePoint(laneId, { t, v });
      }
      ctx.selection.clear();
      return null;
    },
  };

  return [moveHandler, bendHandler, marqueeHandler] as DragHandler<
    LaneHit,
    unknown
  >[];
}
