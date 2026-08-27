// SS9 — Rendering stack for the canvas editor kit.
//
// "Layered per editor, each redrawn only when its inputs change (dirty flags,
// drawn on rAF): grid / content / overlay, plus a DOM playhead."
//
// Two rules the kit enforces so no editor has to remember them:
//   - every canvas is sized `cssPx * devicePixelRatio` and its context is
//     pre-scaled by `dpr`, so a layer draws in CSS pixels only, and aligns
//     1-px strokes to half-pixels (`Math.round(x) + 0.5`) for crispness;
//   - the playhead is a DOM element moved with `transform: translateX()` —
//     playback NEVER invalidates a canvas layer.
//
// Implemented by `canvas-kit` in src/editor/kit/.

import type { Ticks } from "./time";
import type { Viewport } from "./viewport";

/**
 * SS9's three layers, bottom to top. Redraw triggers, frozen:
 *   `grid`    — viewport change only.
 *   `content` — data change or viewport change.
 *   `overlay` — selection, marquee, drag ghosts; the ONLY layer allowed to
 *               redraw every frame during a gesture.
 */
export type LayerKind = "grid" | "content" | "overlay";

export interface LayerFrame {
  /** Already scaled by `dpr` and cleared; draw in CSS pixels. */
  readonly ctx: CanvasRenderingContext2D;
  readonly viewport: Viewport;
  /** CSS pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpr: number;
  /** rAF timestamp of this frame, for animation only. */
  readonly time: number;
}

export interface EditorLayer {
  readonly kind: LayerKind;
  /** Draws the whole layer. Must not mutate the document or the viewport,
   *  must not allocate per item beyond what the 2k-note budget tolerates
   *  (SS2), and must leave `ctx` state as it found it. */
  draw(frame: LayerFrame): void;
  dispose?(): void;
}

/**
 * Owns the canvas stack and the dirty flags. SS15: "`Renderer` is an
 * interface, so a WebGL backend can slot in if profiling ever demands it" —
 * hence nothing outside an `EditorLayer` ever touches a canvas element.
 */
export interface Renderer {
  /** The positioned container holding the canvases and the playhead. */
  readonly element: HTMLElement;
  readonly dpr: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Marks layers dirty; they redraw on the next rAF, once, in kind order. */
  invalidate(kind: LayerKind | readonly LayerKind[]): void;
  invalidateAll(): void;
  /** CSS-pixel resize; also re-applies `dpr` and invalidates everything. */
  resize(widthPx: number, heightPx: number): void;
  /** Draws whatever is dirty right now, synchronously. Tests and teardown —
   *  never the app's animation path. */
  flush(): void;
  dispose(): void;
}

export interface RendererOptions {
  container: HTMLElement;
  viewport: Viewport;
  /** Bottom-to-top; at most one layer per `kind` in M1. */
  layers: readonly EditorLayer[];
  /** Overrides `window.devicePixelRatio` (tests, hi-dpi assertions). */
  dpr?: number | undefined;
  /** Frame pump; defaults to `requestAnimationFrame`. A test passes a manual
   *  pump to make redraws deterministic. */
  requestFrame?: ((cb: (time: number) => void) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
}

export type CreateRenderer = (options: RendererOptions) => Renderer;

/** SS9's DOM playhead. Lives inside `Renderer.element`, above the canvases. */
export interface PlayheadView {
  readonly element: HTMLElement;
  /** Positions via `transform: translateX(viewport.xOf(tick))`. Cheap enough
   *  to call every rAF while playing. */
  setTicks(tick: Ticks): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

// --- content culling (SS9: "binary search ... O(visible) per frame") --------

export interface TickSpan {
  start: Ticks;
  /** Exclusive. A zero-length item still counts as overlapping its `start`. */
  end: Ticks;
}

/**
 * Sorted-by-start index over any item with a tick span (notes, clips, points).
 * `rebuild` on data change, `inRange` per frame.
 *
 * `inRange` returns items OVERLAPPING the window — an item that starts before
 * the window and ends inside it must be drawn — and appends into `out` when
 * given one, so the per-frame path allocates nothing.
 */
export interface TickIndex<T> {
  rebuild(items: readonly T[]): void;
  inRange(from: Ticks, to: Ticks, out?: T[]): readonly T[];
  readonly size: number;
}

export type CreateTickIndex = <T>(spanOf: (item: T) => TickSpan) => TickIndex<T>;
