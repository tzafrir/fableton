// SS11 — pure automation-curve math. No audio, no DOM: the sampler
// (playback), the lane editor (drawing + hit-testing) and the tests all
// evaluate lanes through THESE functions, so what you see is what you hear.
//
// A lane is `points: AutoPoint[]` sorted by `t` (document invariant), each
// point's `curve` (-1..1) bending the segment that STARTS at it:
//   0   -> straight line
//   >0  -> slow start, late rise (ease-in)
//   <0  -> fast start, early rise (ease-out)
// Values are REAL units (SS4); the editor's vertical axis maps them through
// the param's taper so a log sweep draws straight (SS11) — that mapping is
// the editor's, not this file's.

import type { AutoPoint, Ticks } from "../../types";

/** How hard a full bend (|curve| = 1) skews the segment. */
const BEND_EXPONENT_RANGE = 3;

/** The 0..1 shape of one segment: `f(0)=0`, `f(1)=1`, monotonic. */
export function bendShape(t: number, curve: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const c = Math.min(1, Math.max(-1, curve));
  if (c === 0) return clamped;
  const exponent = 1 + Math.abs(c) * BEND_EXPONENT_RANGE;
  // Ease-in for positive bends; the mirrored ease-out for negative.
  return c > 0 ? Math.pow(clamped, exponent) : 1 - Math.pow(1 - clamped, exponent);
}

/**
 * How a lane's segments are read between their endpoints.
 *
 * - `'interpolate'` — continuous params: the bent line of `bendShape`.
 * - `'hold'` — SS11's stepped/enum/toggle params, which "render and edit as
 *   steps" and whose "changes apply exactly at segment boundaries": a point's
 *   value is held for its WHOLE segment and jumps on the next point's tick.
 *   Interpolating them instead would walk a 6-way filter-type lane through
 *   three intermediate types inside one segment, at no boundary at all — the
 *   editor draws steps, so the sampler and the hit-tester must read steps.
 */
export type SegmentMode = "interpolate" | "hold";

/**
 * Lane value at a tick. Before the first point: the first point's value;
 * after the last: the last's (a lane holds its edges, like Live).
 * An empty lane has no opinion — `undefined`, the param's base rules.
 */
export function laneValueAt(
  points: readonly AutoPoint[],
  tick: Ticks,
  mode: SegmentMode = "interpolate",
): number | undefined {
  const n = points.length;
  if (n === 0) return undefined;
  const first = points[0] as AutoPoint;
  if (tick <= first.t) return first.v;
  const last = points[n - 1] as AutoPoint;
  if (tick >= last.t) return last.v;

  // Binary search: greatest i with points[i].t <= tick.
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid] as AutoPoint).t <= tick) lo = mid;
    else hi = mid;
  }
  const a = points[lo] as AutoPoint;
  const b = points[hi] as AutoPoint;
  // Discrete lanes hold `a.v` right up to `b.t` (the early return above has
  // already handled `tick >= b.t` for the last segment, and the search puts
  // `tick` in `[a.t, b.t)` for every other).
  if (mode === "hold") return a.v;
  if (b.t === a.t) return b.v;
  const t = (tick - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * bendShape(t, a.curve);
}

export interface AutomationSample {
  tick: Ticks;
  value: number;
}

/**
 * How a window is sampled, which is the SS11 playback path crossed with the
 * param's kind:
 *
 * - `'ramp'` — AudioParam path, continuous param: every point in the window
 *   plus subdivision of BENT segments (a straight segment needs only its
 *   endpoints — `linearRamp` is exact there).
 * - `'controlRate'` — message path, continuous param: subdivide straight
 *   segments too, because that consumer gets discrete timestamped values at
 *   ~200 Hz, not ramp primitives.
 * - `'hold'` — discrete param (either path): no interpolation exists to
 *   trace, so only the jumps are emitted, as PAIRS (see below).
 */
export type LaneSampleMode = "ramp" | "controlRate" | "hold";

/**
 * Samples a lane over `[fromTick, toTick]` for scheduling: what each `mode`
 * emits is described above, plus exact boundary samples in every mode so
 * consecutive windows join without steps.
 *
 * `maxStepTicks` caps the subdivision spacing (the message path passes the
 * 200 Hz control-rate step; the AudioParam path can afford coarser). It is
 * unused in `'hold'`, which never subdivides.
 */
export function sampleLane(
  points: readonly AutoPoint[],
  fromTick: Ticks,
  toTick: Ticks,
  maxStepTicks: Ticks,
  mode: LaneSampleMode = "ramp",
  out: AutomationSample[] = [],
): AutomationSample[] {
  out.length = 0;
  if (points.length === 0 || toTick < fromTick) return out;
  const step = Math.max(1, Math.round(maxStepTicks));
  const segments: SegmentMode = mode === "hold" ? "hold" : "interpolate";

  const push = (tick: Ticks): void => {
    const value = laneValueAt(points, tick, segments);
    if (value === undefined) return;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.tick === tick) return;
    out.push({ tick, value });
  };

  if (mode === "hold") {
    // A step is emitted as a PAIR — the outgoing value one tick BEFORE the
    // boundary, the new value ON it. That way the AudioParam path's linear
    // ramp between consecutive samples degenerates to a jump (one tick is
    // ~0.5 ms at 120 bpm) and the message path never carries a value the
    // lane does not actually hold. SS11: "enum/toggle changes apply exactly
    // at segment boundaries".
    push(fromTick);
    for (const point of points) {
      if (point.t <= fromTick) continue;
      if (point.t > toTick) break;
      push(point.t - 1);
      push(point.t);
    }
    push(toTick);
    return out;
  }

  push(fromTick);
  // Walk the segments overlapping the window.
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as AutoPoint;
    if (a.t > toTick) break;
    const b = points[i + 1];
    if (a.t >= fromTick && a.t <= toTick) push(a.t);
    if (b === undefined) break;
    if (b.t < fromTick) continue;
    if (a.curve !== 0 || mode === "controlRate") {
      // Subdivide the part of the segment inside the window.
      const start = Math.max(a.t, fromTick);
      const end = Math.min(b.t, toTick);
      for (let t = start + step; t < end; t += step) push(t);
    }
  }
  push(toTick);
  return out;
}
