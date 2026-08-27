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
 * Lane value at a tick. Before the first point: the first point's value;
 * after the last: the last's (a lane holds its edges, like Live).
 * An empty lane has no opinion — `undefined`, the param's base rules.
 */
export function laneValueAt(points: readonly AutoPoint[], tick: Ticks): number | undefined {
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
  if (b.t === a.t) return b.v;
  const t = (tick - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * bendShape(t, a.curve);
}

export interface AutomationSample {
  tick: Ticks;
  value: number;
}

/**
 * Samples a lane over `[fromTick, toTick]` for scheduling: every point
 * inside the window, plus subdivision of BENT segments (a straight segment
 * needs only its endpoints — `linearRamp` is exact there), plus exact
 * boundary samples so consecutive windows join without steps.
 *
 * `maxStepTicks` caps the subdivision spacing (the message path passes the
 * 200 Hz control-rate step; the AudioParam path can afford coarser).
 *
 * `subdivideStraight` forces the step on STRAIGHT segments too — the SS11
 * message path samples at control rate throughout, because its consumer
 * gets discrete timestamped values, not ramp primitives.
 */
export function sampleLane(
  points: readonly AutoPoint[],
  fromTick: Ticks,
  toTick: Ticks,
  maxStepTicks: Ticks,
  out: AutomationSample[] = [],
  subdivideStraight = false,
): AutomationSample[] {
  out.length = 0;
  if (points.length === 0 || toTick < fromTick) return out;
  const step = Math.max(1, Math.round(maxStepTicks));

  const push = (tick: Ticks): void => {
    const value = laneValueAt(points, tick);
    if (value === undefined) return;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.tick === tick) return;
    out.push({ tick, value });
  };

  push(fromTick);
  // Walk the segments overlapping the window.
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as AutoPoint;
    if (a.t > toTick) break;
    const b = points[i + 1];
    if (a.t >= fromTick && a.t <= toTick) push(a.t);
    if (b === undefined) break;
    if (b.t < fromTick) continue;
    if (a.curve !== 0 || subdivideStraight) {
      // Subdivide the part of the segment inside the window.
      const start = Math.max(a.t, fromTick);
      const end = Math.min(b.t, toTick);
      for (let t = start + step; t < end; t += step) push(t);
    }
  }
  push(toTick);
  return out;
}
