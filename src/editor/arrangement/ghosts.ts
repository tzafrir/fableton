// SS9, overlay layer — "selection, marquee, drag ghosts; the ONLY layer
// redrawing at 60 fps during a gesture."
//
// Every drawing routine here takes musical units and the frame's viewport,
// never stored pixels: a ghost drawn while the user scrolls with the wheel
// mid-drag stays glued to its ticks.

import type { LayerFrame } from "../../types/render";
import type { Ticks } from "../../types/time";
import { alignHalfPixel, alignPixel } from "../kit";
import type { ArrangementTheme } from "./constants";
import type { ClipGhost } from "./edits";
import { braceHeightPx, clipRect } from "./geometry";

export function drawClipOutline(
  frame: LayerFrame,
  row: number,
  start: Ticks,
  length: Ticks,
  color: string,
  lineWidth = 2,
): void {
  const rect = clipRect(frame.viewport, row, start, length);
  if (rect.x > frame.widthPx || rect.x + rect.w < 0) return;
  const { ctx } = frame;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(
    alignHalfPixel(rect.x),
    alignHalfPixel(rect.y),
    Math.max(1, alignPixel(rect.w)),
    Math.max(1, alignPixel(rect.h)),
  );
}

/** The drag preview itself: translucent bodies plus a crisp outline, and the
 *  loop brace when the dragged clip carries one. */
export function drawGhosts(
  frame: LayerFrame,
  theme: ArrangementTheme,
  ghosts: readonly ClipGhost[],
): void {
  const { ctx } = frame;
  const brace = braceHeightPx(frame.viewport);
  for (const ghost of ghosts) {
    const rect = clipRect(frame.viewport, ghost.row, ghost.start, ghost.length);
    if (rect.x > frame.widthPx || rect.x + rect.w < 0) continue;
    ctx.fillStyle = theme.ghostFill;
    ctx.fillRect(alignPixel(rect.x), alignPixel(rect.y), Math.max(1, alignPixel(rect.w)), alignPixel(rect.h));
    ctx.strokeStyle = theme.ghostOutline;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      alignHalfPixel(rect.x),
      alignHalfPixel(rect.y),
      Math.max(1, alignPixel(rect.w)),
      Math.max(1, alignPixel(rect.h)),
    );
    if (ghost.loop !== null && brace > 0) {
      const x0 = frame.viewport.xOf(ghost.start + ghost.loop.start);
      const x1 = frame.viewport.xOf(ghost.start + ghost.loop.end);
      ctx.fillStyle = theme.clipLoopBrace;
      ctx.fillRect(alignPixel(x0), alignPixel(rect.y), Math.max(1, alignPixel(x1 - x0)), alignPixel(brace));
    }
  }
}

/** The marquee rectangle, in (tick, row) space so it survives a scroll. */
export function drawMarquee(
  frame: LayerFrame,
  theme: ArrangementTheme,
  fromTick: Ticks,
  toTick: Ticks,
  fromRow: number,
  toRow: number,
): void {
  const { ctx, viewport } = frame;
  const x0 = viewport.xOf(Math.min(fromTick, toTick));
  const x1 = viewport.xOf(Math.max(fromTick, toTick));
  const y0 = viewport.yOf(Math.min(fromRow, toRow));
  const y1 = viewport.yOf(Math.max(fromRow, toRow));
  ctx.fillStyle = theme.marqueeFill;
  ctx.fillRect(alignPixel(x0), alignPixel(y0), Math.max(1, alignPixel(x1 - x0)), Math.max(1, alignPixel(y1 - y0)));
  ctx.strokeStyle = theme.marqueeOutline;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    alignHalfPixel(x0),
    alignHalfPixel(y0),
    Math.max(1, alignPixel(x1 - x0)),
    Math.max(1, alignPixel(y1 - y0)),
  );
}
