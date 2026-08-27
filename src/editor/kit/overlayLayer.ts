// SS9, layer 3 — "selection, marquee, drag ghosts; the ONLY layer redrawing at
// 60 fps during a gesture."
//
// The kit ships the plumbing half: a layer that asks the ACTIVE drag handler
// to draw its own ghosts (`DragHandler.drawPreview`). An editor that prefers
// one hand-written overlay layer omits `drawPreview` and reads
// `GestureEngine.preview` instead — both routes are in the contract.

import type { EditorLayer, LayerFrame } from "../../types/render";
import type { HitTarget } from "../../types/gesture";
import type { KitGestureEngine } from "./gestureEngine";

export interface GestureOverlayOptions<THit extends HitTarget> {
  engine: KitGestureEngine<THit>;
  /** Drawn UNDER the active handler's ghosts (selection outlines, hover). */
  drawBelow?: ((frame: LayerFrame) => void) | undefined;
  /** Drawn OVER them (marquee rectangle, tooltips). */
  drawAbove?: ((frame: LayerFrame) => void) | undefined;
}

export function createGestureOverlayLayer<THit extends HitTarget>(
  options: GestureOverlayOptions<THit>,
): EditorLayer {
  return {
    kind: "overlay",
    draw(frame: LayerFrame): void {
      options.drawBelow?.(frame);
      options.engine.drawActivePreview(frame);
      options.drawAbove?.(frame);
    },
  };
}
