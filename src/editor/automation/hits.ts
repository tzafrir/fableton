// SS11 — what is under the pointer in an automation lane: a point marker, a
// bendable segment, the flat run outside the points, or empty space. The zones
// are what SS11's verbs are written against ("click a segment to add a point,
// drag a point ..., drag a segment's middle to bend `curve`, marquee").

import type { EditorPoint, HitTester, Ticks } from "../../types";
import { laneValueAt } from "../../engine/automation/curve";
import { segmentModeOf, type AutomationLaneContext } from "./context";
import { POINT_HIT_PX, SEGMENT_HIT_PX, yOfValue } from "./layout";
import { segmentIndexAt, visiblePointRange } from "./points";

export interface PointHit {
  kind: "point";
  cursor?: string;
  t: Ticks;
}
export interface SegmentHit {
  kind: "segment";
  cursor?: string;
  /** Tick of the point the segment STARTS at. */
  startT: Ticks;
}
/**
 * The flat run the lane draws BEFORE its first point and AFTER its last (a
 * lane holds its edges, curve.ts). It is a drawn line, so SS11's "click a
 * segment to add a point" must work on it — but it is not a bendable segment,
 * so it is its own zone rather than a `SegmentHit` pointing at a segment the
 * cursor is nowhere near.
 */
export interface FlatHit {
  kind: "flat";
  cursor?: string;
}
export interface EmptyHit {
  kind: "empty";
  cursor?: string;
}
export type LaneHit = PointHit | SegmentHit | FlatHit | EmptyHit;

export const AUTOMATION_HIT_TESTER_ID = "automation.zones";

export function createAutomationHitTester(ctx: AutomationLaneContext): HitTester<LaneHit> {
  return {
    id: AUTOMATION_HIT_TESTER_ID,
    hitTest(point: EditorPoint): LaneHit | null {
      const desc = ctx.desc();
      if (desc === null || ctx.laneId() === null) return null;
      const pts = ctx.points();
      if (pts.length === 0) return { kind: "empty" };
      const heightPx = ctx.heightPx();
      const viewport = ctx.viewport;

      // Point markers first, over the markers that can reach the pointer at
      // all: SS9 culling applies to hit-testing exactly as it does to drawing.
      const near = visiblePointRange(
        pts,
        viewport.tAt(point.xPx - POINT_HIT_PX),
        viewport.tAt(point.xPx + POINT_HIT_PX),
      );
      for (let i = near.start; i < near.end; i++) {
        const p = pts[i] as { t: Ticks; v: number };
        const px = viewport.xOf(p.t);
        const py = yOfValue(desc, p.v, heightPx);
        if (Math.abs(px - point.xPx) <= POINT_HIT_PX && Math.abs(py - point.yPx) <= POINT_HIT_PX) {
          return { kind: "point", cursor: "grab", t: p.t };
        }
      }

      // Then the curve itself. Everywhere it is drawn, it can be clicked to
      // add a point (SS11) — but only the run BETWEEN two points is a
      // bendable `segment`. A lane holds its edges (curve.ts), so the flat
      // lead-in before the first point and the flat trail after the last are
      // drawn lines belonging to no segment: reporting them as one (as the
      // first cut did, resolving them to `pts[0]` / the last point) would bend
      // a segment the cursor is nowhere near, or store a bend on a point with
      // no following segment at all. They are `flat` — click-to-add, no bend.
      const value = laneValueAt(pts, point.tick, segmentModeOf(desc));
      if (
        value !== undefined &&
        Math.abs(yOfValue(desc, value, heightPx) - point.yPx) <= SEGMENT_HIT_PX
      ) {
        const first = pts[0] as { t: Ticks };
        const last = pts[pts.length - 1] as { t: Ticks };
        if (point.tick >= first.t && point.tick < last.t) {
          const index = segmentIndexAt(pts, point.tick);
          const start = pts[index];
          if (start !== undefined) return { kind: "segment", cursor: "copy", startT: start.t };
        }
        return { kind: "flat", cursor: "copy" };
      }
      return { kind: "empty" };
    },
  };
}
