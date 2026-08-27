// SS9, layer 4 — "a 1-px DOM element moved via `transform: translateX()`, so
// playback never forces canvas repaints."
//
// The whole point of this file is what it does NOT do: `setTicks` touches one
// style property and never calls `renderer.invalidate`. At 60 fps that is the
// difference between a free playhead and a full content-layer redraw per
// frame with 2,000 notes on screen (SS2).

import type { PlayheadView } from "../../types/render";
import type { Ticks } from "../../types/time";
import type { Viewport } from "../../types/viewport";

export interface PlayheadOptions {
  /** Normally `renderer.element`. */
  container: HTMLElement;
  viewport: Viewport;
  /** CSS color; the app shell's theme overrides it via the class name. */
  color?: string | undefined;
}

export function createPlayheadView(options: PlayheadOptions): PlayheadView {
  const { viewport } = options;
  let tick: Ticks = 0;
  let visible = true;
  let disposed = false;

  const element = document.createElement("div");
  element.className = "fbl-playhead";
  element.style.position = "absolute";
  element.style.top = "0";
  element.style.left = "0";
  element.style.width = "1px";
  element.style.height = "100%";
  element.style.pointerEvents = "none";
  element.style.willChange = "transform";
  element.style.background = options.color ?? "currentColor";
  // Above every canvas layer (renderer assigns z-index 1..n to the canvases).
  element.style.zIndex = "100";
  options.container.appendChild(element);

  const position = (): void => {
    // Whole device pixels: a playhead on a half pixel shimmers while playing.
    element.style.transform = `translateX(${String(Math.round(viewport.xOf(tick)))}px)`;
  };

  const applyVisibility = (): void => {
    element.style.display = visible ? "block" : "none";
  };

  position();
  applyVisibility();

  // Scroll/zoom moves the playhead; this is a style write, not a redraw.
  const unsubscribe = viewport.onChange(position);

  return {
    element,
    setTicks(next: Ticks): void {
      if (disposed || next === tick) return;
      tick = next;
      position();
    },
    setVisible(next: boolean): void {
      if (disposed || next === visible) return;
      visible = next;
      applyVisibility();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      element.remove();
    },
  };
}
