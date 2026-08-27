// SS11 — the lane editor's value axis: REAL units mapped through the
// param's taper, so a log-taper cutoff sweep draws straight when it sounds
// straight. Pure math; the view and its tests share it.

import type { ParamDescriptor } from "../../types";
import { fromNormalized, toNormalized } from "../../params/taper";

/** Vertical padding inside the lane so edge points stay grabbable. */
export const LANE_PAD_PX = 8;
/** Point marker radius (drawing) and its hit slop. */
export const POINT_RADIUS_PX = 4;
export const POINT_HIT_PX = 7;
/** Vertical distance within which a segment is grabbable. */
export const SEGMENT_HIT_PX = 6;
/** Vertical drag pixels for a full curve bend sweep (-1..1). */
export const BEND_DRAG_RANGE_PX = 120;

export function yOfValue(desc: ParamDescriptor, value: number, heightPx: number): number {
  const n = toNormalized(desc, value);
  const span = Math.max(1, heightPx - LANE_PAD_PX * 2);
  return LANE_PAD_PX + (1 - n) * span;
}

export function valueAtY(desc: ParamDescriptor, yPx: number, heightPx: number): number {
  const span = Math.max(1, heightPx - LANE_PAD_PX * 2);
  const n = Math.min(1, Math.max(0, 1 - (yPx - LANE_PAD_PX) / span));
  return fromNormalized(desc, n);
}
