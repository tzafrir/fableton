// SS11 — the lane editor's TICK-axis math, kept apart from `layout.ts` (which
// owns the value axis). Three rules that the view, the hit tester and the
// gesture handlers must all apply identically, so they are written once:
//
//   * which points a frame has to touch at all (SS9 culling),
//   * which segment a tick falls in,
//   * how far a group of points may move left.
//
// Every function assumes the document invariant: `points` sorted by `t`, one
// point per tick.

import type { AutoPoint, Ticks } from "../../types";

/** Half-open index window into a lane's `points`. */
export interface PointIndexRange {
  /** First index to touch. */
  start: number;
  /** One past the last index to touch. */
  end: number;
}

/** First index with `points[i].t >= tick` (binary search). */
function lowerBound(points: readonly AutoPoint[], tick: Ticks): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((points[mid] as AutoPoint).t >= tick) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * SS9: "Content culls to the viewport ... O(visible) per frame." The points a
 * `[fromTick, toTick]` window needs, PLUS one either side — the segments that
 * cross the left and right edges are drawn (and hit-tested) from endpoints
 * that are themselves off-screen, so dropping the neighbours would leave a
 * gap at each edge.
 */
export function visiblePointRange(
  points: readonly AutoPoint[],
  fromTick: Ticks,
  toTick: Ticks,
): PointIndexRange {
  const n = points.length;
  if (n === 0) return { start: 0, end: 0 };
  const first = lowerBound(points, fromTick);
  const last = lowerBound(points, toTick + 1); // first index past the window
  return { start: Math.max(0, first - 1), end: Math.min(n, last + 1) };
}

/**
 * Index of the point whose segment CONTAINS `tick` — the greatest `i` with
 * `points[i].t <= tick`, or `-1` when `tick` is before the first point.
 * The last point's index is returned for any tick at or after it; callers
 * that need a BENDABLE segment must reject that case themselves (there is no
 * segment after the last point).
 */
export function segmentIndexAt(points: readonly AutoPoint[], tick: Ticks): number {
  return lowerBound(points, tick + 1) - 1;
}

/** Earliest tick in a group; `0` for an empty group (nothing to clamp). */
export function earliestTick(points: readonly AutoPoint[]): Ticks {
  let min = Number.POSITIVE_INFINITY;
  for (const point of points) if (point.t < min) min = point.t;
  return Number.isFinite(min) ? min : 0;
}

/**
 * SS10 "Moves are relative": a horizontal move clamps the DELTA against the
 * earliest point in the group — never each point on its own.
 *
 * Clamping points individually would pile everything that reached the tick-0
 * wall onto tick 0, and a lane holds one point per tick: `moveLanePoints`
 * would then commit a selection collapsed into a single point, destroying the
 * rest of the curve on one ArrowLeft. `clampGroupDelta` in the piano roll's
 * `dragCommon.ts` is the same rule for notes.
 */
export function clampMoveDeltaTicks(deltaTicks: Ticks, earliestT: Ticks): Ticks {
  return Math.max(deltaTicks, -earliestT);
}
