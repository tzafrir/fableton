// SS8 — TempoMap: piecewise tick<->seconds integration over constant-tempo
// segments. v1 (SS18 M0) constructs a single fixed-tempo segment via
// `createFixedTempoMap`, but the general `createTempoMap` takes the full
// segment list so tempo automation later is a data change, not a refactor.

import type { Bpm, Seconds, TempoMap, TempoSegment, Ticks } from "../types";
import { PPQ } from "../types";
import { assertIntegerTicks, requireIntegerTicks, requirePositiveFinite } from "./dev";

const SECONDS_PER_MINUTE = 60;

/** Seconds elapsed for `ticks` at a constant `bpm`. */
function ticksToSeconds(ticks: number, bpm: Bpm): Seconds {
  return (ticks * SECONDS_PER_MINUTE) / (bpm * PPQ);
}

/** Inverse of `ticksToSeconds` — NOT rounded; callers round at the boundary
 *  documented on `TempoMap.ticksAt`. */
function secondsToTicks(seconds: Seconds, bpm: Bpm): number {
  return (seconds * bpm * PPQ) / SECONDS_PER_MINUTE;
}

/**
 * Validates the invariants documented on `TempoMap` (SS8): non-empty,
 * sorted by `startTick`, first segment at tick 0, every bpm positive and
 * finite, every `startTick` an integer.
 *
 * Every check here runs in EVERY build, dev-only guards included: this is a
 * cold path (once per document load or tempo edit, never per event), the
 * throw is the documented contract of `createTempoMap`, and a map built from
 * a bpm of 0 does not fail loudly later — it quietly produces Infinity/NaN
 * seconds for the rest of the session.
 */
function validateSegments(segments: readonly TempoSegment[]): void {
  if (segments.length === 0) {
    throw new Error("TempoMap: segments must be non-empty");
  }
  const first = segments[0]!;
  if (first.startTick !== 0) {
    throw new Error(
      `TempoMap: first segment must start at tick 0, got ${String(first.startTick)}`,
    );
  }
  let prevStart = -Infinity;
  for (const seg of segments) {
    requireIntegerTicks(seg.startTick, "TempoMap segment.startTick");
    requirePositiveFinite(seg.bpm, "TempoMap segment.bpm");
    if (seg.startTick <= prevStart) {
      throw new Error(
        "TempoMap: segments must be sorted by strictly increasing startTick",
      );
    }
    prevStart = seg.startTick;
  }
}

/** Largest index `i` such that `xs[i] <= target`, assuming `xs` sorted
 *  ascending and `xs[0] <= target` is not guaranteed — clamps to 0. */
function floorIndex(xs: readonly number[], target: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (target < xs[0]!) return 0;
  while (lo < hi) {
    // Bias the midpoint high so we converge on the greatest index whose
    // value is <= target (standard "upper bound - 1" binary search).
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (xs[mid]! <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Builds a `TempoMap` from an explicit list of `(startTick, bpm)` segments.
 * Throws if the segment invariants (SS8) are violated.
 */
export function createTempoMap(
  segments: readonly TempoSegment[],
): TempoMap {
  validateSegments(segments);
  // Defensive copy — the map owns its segment list from here on.
  const segs: readonly TempoSegment[] = segments.map((s) => ({ ...s }));
  const startTicks = segs.map((s) => s.startTick);

  // Cumulative seconds at the start of each segment, computed once.
  const prefixSeconds: number[] = [0];
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1]!;
    const cur = segs[i]!;
    const dt = ticksToSeconds(cur.startTick - prev.startTick, prev.bpm);
    prefixSeconds.push(prefixSeconds[i - 1]! + dt);
  }

  function segmentIndexForTick(tick: Ticks): number {
    return floorIndex(startTicks, tick);
  }

  function segmentIndexForSeconds(seconds: Seconds): number {
    return floorIndex(prefixSeconds, seconds);
  }

  const map: TempoMap = {
    segments: segs,
    ppq: PPQ,

    secondsAt(tick: Ticks): Seconds {
      assertIntegerTicks(tick, "TempoMap.secondsAt(tick)");
      const i = segmentIndexForTick(tick);
      const seg = segs[i]!;
      return prefixSeconds[i]! + ticksToSeconds(tick - seg.startTick, seg.bpm);
    },

    ticksAt(seconds: Seconds): Ticks {
      const i = segmentIndexForSeconds(seconds);
      const seg = segs[i]!;
      const raw =
        seg.startTick + secondsToTicks(seconds - prefixSeconds[i]!, seg.bpm);
      return Math.round(raw);
    },

    secondsBetween(fromTick: Ticks, toTick: Ticks): Seconds {
      return map.secondsAt(toTick) - map.secondsAt(fromTick);
    },

    bpmAt(tick: Ticks): Bpm {
      assertIntegerTicks(tick, "TempoMap.bpmAt(tick)");
      const i = segmentIndexForTick(tick);
      return segs[i]!.bpm;
    },
  };

  return map;
}

/**
 * Convenience for v1 (SS18 M0): a single fixed-tempo segment starting at
 * tick 0. Every consumer still goes through the full `TempoMap` interface.
 */
export function createFixedTempoMap(bpm: Bpm): TempoMap {
  return createTempoMap([{ startTick: 0, bpm }]);
}
