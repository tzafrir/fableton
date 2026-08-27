// The piano roll's verb table: SS10's gesture FSM, assembled.
//
//   | State        | Entered by     | Handler                  |
//   |--------------|----------------|--------------------------|
//   | Idle         | -              | (hover -> hits.ts)       |
//   | Pending      | pointerdown    | the kit's FSM            |
//   | DragMove     | body           | pianoroll.drag-move      |
//   | DragResizeL  | left edge      | pianoroll.drag-resize-l  |
//   | DragResizeR  | right edge     | pianoroll.drag-resize-r  |
//   | DragDup      | Alt+body       | pianoroll.drag-dup       |
//   | Marquee      | empty          | pianoroll.marquee        |
//   | DragVel      | velocity stalk | pianoroll.drag-vel       |
//   | Paint        | pencil drag    | pianoroll.paint          |
//
// Claims are disjoint by zone + modifier, except `DragMove` vs `DragDup`
// (`Alt`) and `Marquee` vs `Paint` (tool), which priority settles.

import type { DragHandler } from "../../types/gesture";
import type { ContextRef } from "./context";
import type { PianoRollHit } from "./hits";
import { createDupDragHandler, createMoveDragHandler } from "./dragMove";
import { createMarqueeDragHandler } from "./dragMarquee";
import { createPaintDragHandler, createSeekDragHandler } from "./dragPaint";
import { createResizeDragHandler } from "./dragResize";
import { createVelocityDragHandler } from "./dragVelocity";

export function createPianoRollDragHandlers(
  ref: ContextRef,
): readonly DragHandler<PianoRollHit, unknown>[] {
  return [
    createSeekDragHandler(ref),
    createPaintDragHandler(ref),
    createResizeDragHandler(ref, "l"),
    createResizeDragHandler(ref, "r"),
    createDupDragHandler(ref),
    createMoveDragHandler(ref),
    createVelocityDragHandler(ref),
    createMarqueeDragHandler(ref),
  ] as readonly DragHandler<PianoRollHit, unknown>[];
}
