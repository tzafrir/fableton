// SS9 culling + SS10 relative-move clamping, on the pure tick-axis helpers
// the view, the hit tester and the handlers all share.

import { describe, expect, it } from "vitest";
import type { AutoPoint } from "../../types";
import {
  clampMoveDeltaTicks,
  earliestTick,
  segmentIndexAt,
  visiblePointRange,
} from "./points";

const pts = (ticks: readonly number[]): AutoPoint[] =>
  ticks.map((t) => ({ t, v: 0, curve: 0 }));

describe("visiblePointRange", () => {
  const points = pts([0, 240, 480, 720, 960]);

  it("keeps one point either side so the edge segments still have endpoints", () => {
    const range = visiblePointRange(points, 300, 600);
    expect(range).toEqual({ start: 1, end: 4 }); // 240..720, the window is 480 only
  });

  it("covers the whole lane when the window does", () => {
    expect(visiblePointRange(points, -1000, 5000)).toEqual({ start: 0, end: 5 });
  });

  it("returns the neighbouring point when the window falls between points", () => {
    const range = visiblePointRange(points, 500, 700);
    expect(points.slice(range.start, range.end).map((p) => p.t)).toEqual([480, 720]);
  });

  it("degenerates safely on an empty lane and on windows off either end", () => {
    expect(visiblePointRange([], 0, 100)).toEqual({ start: 0, end: 0 });
    expect(visiblePointRange(points, 5000, 6000)).toEqual({ start: 4, end: 5 });
    expect(visiblePointRange(points, -2000, -1000)).toEqual({ start: 0, end: 1 });
  });

  // The point of the exercise (SS9 "O(visible) per frame"): a dense imported
  // lane must cost the frame its VISIBLE points, not its total.
  it("is O(visible) on a dense lane", () => {
    const dense = pts(Array.from({ length: 10_000 }, (_, i) => i * 10));
    const range = visiblePointRange(dense, 5000, 6000);
    expect(range.end - range.start).toBeLessThanOrEqual(103);
    expect(dense[range.start]?.t).toBeLessThanOrEqual(5000);
    expect(dense[range.end - 1]?.t).toBeGreaterThanOrEqual(6000);
  });
});

describe("segmentIndexAt", () => {
  const points = pts([0, 240, 960]);

  it("finds the point whose segment contains the tick", () => {
    expect(segmentIndexAt(points, 0)).toBe(0);
    expect(segmentIndexAt(points, 239)).toBe(0);
    expect(segmentIndexAt(points, 240)).toBe(1);
    expect(segmentIndexAt(points, 5000)).toBe(2);
  });

  it("reports -1 before the first point (no segment starts there)", () => {
    expect(segmentIndexAt(points, -1)).toBe(-1);
    expect(segmentIndexAt([], 0)).toBe(-1);
  });
});

describe("clampMoveDeltaTicks", () => {
  // SS10 "moves are relative": the group shifts by ONE clamped delta, so a
  // move into the left wall preserves the shape instead of folding the
  // selection onto tick 0 (where one point per tick would eat the rest).
  it("clamps the delta to the earliest point, not each point", () => {
    const group = pts([240, 720]);
    const delta = clampMoveDeltaTicks(-480, earliestTick(group));
    expect(delta).toBe(-240);
    expect(group.map((p) => p.t + delta)).toEqual([0, 480]);
  });

  it("passes rightward and in-range moves through untouched", () => {
    expect(clampMoveDeltaTicks(960, 0)).toBe(960);
    expect(clampMoveDeltaTicks(-120, 480)).toBe(-120);
  });

  it("earliestTick of an empty group clamps nothing away", () => {
    expect(earliestTick([])).toBe(0);
    // `=== 0` rather than `toBe(0)`: `Math.max(-100, -0)` is -0, which is a
    // move of nothing all the same.
    expect(clampMoveDeltaTicks(-100, earliestTick([])) === 0).toBe(true);
  });
});
