// SS9 "Coordinate discipline" for the arrangement skin: the ONE place this
// package converts between clips and pixels.
//
// The row convention is frozen (types/viewport.ts): `row = index in
// Project.channelOrder`, rows increase downward, row `n` occupies `[n, n+1)`.
// Vertical hit-testing is therefore pure row arithmetic; only the horizontal
// zones (SS10's edge zones, the loop brace handles) need pixels, because they
// are defined in pixels: "min(6 px, 40% of note width)".
//
// Everything here is a pure function of (viewport, clip, row) — no DOM, no
// canvas, no document — which is what makes it unit-testable headlessly (SS15).

import type { MidiClip } from "../../types/clip";
import type { Immutable } from "../../types/commands";
import type { Ticks } from "../../types/time";
import type { Viewport } from "../../types/viewport";
import {
  CLIP_INSET_PX,
  EDGE_ZONE_FRACTION,
  EDGE_ZONE_PX,
  LOOP_BRACE_FRACTION,
  LOOP_BRACE_PX,
  LOOP_HANDLE_PX,
  MIN_BRACE_LANE_PX,
} from "./constants";

/** A clip as the editor reads it: deep-readonly, straight off the snapshot. */
export type ClipView = Immutable<MidiClip>;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The zones a pointer can land in on a clip, in resolution order.
 *
 *   `loopStart` / `loopEnd` — the loop brace handles (SS10's clip `loop`)
 *   `loopBody`              — the brace between them: slides the loop window
 *   `edgeL` / `edgeR`       — trim, `min(6 px, 40% of clip width)` per side
 *   `body`                  — move (and double-click: open the piano roll)
 */
export type ClipZone = "loopStart" | "loopEnd" | "loopBody" | "edgeL" | "edgeR" | "body";

export const ZONE_CURSORS: Readonly<Record<ClipZone, string>> = {
  loopStart: "col-resize",
  loopEnd: "col-resize",
  loopBody: "grab",
  edgeL: "ew-resize",
  edgeR: "ew-resize",
  body: "default",
};

/** Pixel span of a clip on the time axis. Width floors at 1 px so a very
 *  short clip stays visible and clickable at any zoom. */
export function clipSpanPx(
  viewport: Viewport,
  start: Ticks,
  length: Ticks,
): { readonly x: number; readonly w: number } {
  return { x: viewport.xOf(start), w: Math.max(1, length * viewport.pxPerTick) };
}

/** The full lane cell of a row: `[row, row + 1)` in the frozen convention. */
export function laneRect(viewport: Viewport, row: number, widthPx: number): Rect {
  return { x: 0, y: viewport.yOf(row), w: widthPx, h: viewport.pxPerRow };
}

/** The drawn clip rectangle: the lane cell inset vertically so neighbouring
 *  lanes stay visually separated. Hit-testing uses rows, not this rect. */
export function clipRect(
  viewport: Viewport,
  row: number,
  start: Ticks,
  length: Ticks,
): Rect {
  const span = clipSpanPx(viewport, start, length);
  const inset = Math.min(CLIP_INSET_PX, viewport.pxPerRow / 4);
  return {
    x: span.x,
    y: viewport.yOf(row) + inset,
    w: span.w,
    h: Math.max(1, viewport.pxPerRow - inset * 2),
  };
}

/** SS10, verbatim: "left/right edge zones: `min(6 px, 40% of note width)`
 *  each side, so short notes always keep a grabbable body." */
export function edgeZonePx(widthPx: number): number {
  return Math.min(EDGE_ZONE_PX, EDGE_ZONE_FRACTION * widthPx);
}

/** Height of the loop brace band for a lane; 0 when the lane is too short for
 *  the brace to be a hit target (it is still drawn as a hairline). */
export function braceHeightPx(viewport: Viewport): number {
  if (viewport.pxPerRow < MIN_BRACE_LANE_PX) return 0;
  return Math.min(LOOP_BRACE_PX, viewport.pxPerRow * LOOP_BRACE_FRACTION);
}

/** Absolute song ticks of a clip's loop brace, or `null` when it has none. */
export function loopSpanTicks(
  clip: ClipView,
): { readonly start: Ticks; readonly end: Ticks } | null {
  const loop = clip.loop;
  if (loop === undefined || loop === null) return null;
  return { start: clip.start + loop.start, end: clip.start + loop.end };
}

/** True when `tick` falls inside `[clip.start, clip.start + clip.length)`. */
export function clipContainsTick(clip: ClipView, tick: Ticks): boolean {
  return tick >= clip.start && tick < clip.start + clip.length;
}

/**
 * Which zone of `clip` the point is in, or `null` when it is outside.
 * `row` is the clip's row; the caller has already matched it.
 */
export function zoneAt(
  viewport: Viewport,
  clip: ClipView,
  row: number,
  xPx: number,
  yPx: number,
): ClipZone | null {
  const { x, w } = clipSpanPx(viewport, clip.start, clip.length);
  if (xPx < x || xPx > x + w) return null;
  const top = viewport.yOf(row);
  if (yPx < top || yPx >= top + viewport.pxPerRow) return null;

  const brace = braceHeightPx(viewport);
  const loop = loopSpanTicks(clip);
  if (loop !== null && brace > 0 && yPx - top <= brace) {
    const loopStartX = viewport.xOf(loop.start);
    const loopEndX = viewport.xOf(loop.end);
    if (Math.abs(xPx - loopStartX) <= LOOP_HANDLE_PX) return "loopStart";
    if (Math.abs(xPx - loopEndX) <= LOOP_HANDLE_PX) return "loopEnd";
    if (xPx > loopStartX && xPx < loopEndX) return "loopBody";
  }

  const zone = edgeZonePx(w);
  if (xPx <= x + zone) return "edgeL";
  if (xPx >= x + w - zone) return "edgeR";
  return "body";
}

/** Do two half-open tick spans overlap? A zero-length span still covers its
 *  own start tick (matches `TickIndex`'s contract). */
export function spansOverlap(
  aStart: Ticks,
  aEnd: Ticks,
  bStart: Ticks,
  bEnd: Ticks,
): boolean {
  if (aEnd <= aStart) return aStart >= bStart && aStart < bEnd;
  if (bEnd <= bStart) return bStart >= aStart && bStart < aEnd;
  return aStart < bEnd && bStart < aEnd;
}
