// SS9 — "Rendering stack. Layered per editor, each redrawn only when its
// inputs change (dirty flags, drawn on rAF):
//   1. Grid layer    — redraws on viewport change only.
//   2. Content layer — redraws on data or viewport change.
//   3. Overlay layer — selection, marquee, drag ghosts; the ONLY layer
//                      redrawing at 60 fps during a gesture.
//   4. Playhead      — a 1-px DOM element moved via transform: translateX(),
//                      so playback never forces canvas repaints.
//  All canvases render at `devicePixelRatio` with lines aligned to
//  half-pixels for crispness."
//
// The dirty-flag bookkeeping is the entire point: a 2,000-note content layer
// must NOT redraw because a ghost moved (SS2's 60 fps budget). Layers draw in
// CSS pixels; the `dpr` multiply happens here and nowhere else.

import type {
  CreateRenderer,
  EditorLayer,
  LayerFrame,
  LayerKind,
  Renderer,
  RendererOptions,
} from "../../types/render";
import type { Viewport } from "../../types/viewport";

/** Bottom to top. Also the redraw order within one frame. */
export const LAYER_ORDER: readonly LayerKind[] = ["grid", "content", "overlay"];

/**
 * Aligns a 1-px stroke to the pixel grid. A vertical line at integer x with a
 * 1-px stroke straddles two device columns and renders as a 2-px smear; at
 * `x + 0.5` it lands on exactly one. Every layer that strokes hairlines
 * (bar lines, row separators, note outlines) runs its coordinates through
 * this — hence it lives in the kit, not in each editor.
 */
export function alignHalfPixel(px: number): number {
  return Math.round(px) + 0.5;
}

/** Same idea for fills: snap a rect edge to a whole device pixel. */
export function alignPixel(px: number): number {
  return Math.round(px);
}

function resolveDpr(explicit: number | undefined): number {
  if (explicit !== undefined && explicit > 0) return explicit;
  const fromWindow = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return fromWindow > 0 ? fromWindow : 1;
}

interface LayerSlot {
  readonly layer: EditorLayer;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  dirty: boolean;
}

export const createRenderer: CreateRenderer = (options: RendererOptions): Renderer => {
  const viewport: Viewport = options.viewport;
  let dpr = resolveDpr(options.dpr);
  let widthPx = Math.max(0, viewport.widthPx);
  let heightPx = Math.max(0, viewport.heightPx);
  let disposed = false;

  const requestFrame =
    options.requestFrame ??
    ((cb: (time: number) => void) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(cb)
        : (setTimeout(() => cb(Date.now()), 16) as unknown as number));
  const cancelFrame =
    options.cancelFrame ??
    ((handle: number) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });

  const element = document.createElement("div");
  element.className = "fbl-editor";
  element.style.position = "relative";
  element.style.overflow = "hidden";
  element.style.width = "100%";
  element.style.height = "100%";
  element.style.outline = "none";
  options.container.appendChild(element);

  const slots: LayerSlot[] = options.layers.map((layer, i) => {
    const canvas = document.createElement("canvas");
    canvas.className = `fbl-layer fbl-layer-${layer.kind}`;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.zIndex = String(i + 1);
    // Canvases never take pointer events; the gesture engine listens on the
    // container so hit-testing is pure math against the model (SS10).
    canvas.style.pointerEvents = "none";
    element.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error(
        `createRenderer: no 2d context for the '${layer.kind}' layer (jsdom needs a getContext stub — see ./testing/fakeCanvas.ts)`,
      );
    }
    return { layer, canvas, ctx, dirty: true };
  });

  const applyCanvasSize = (slot: LayerSlot): void => {
    // The ONE place `devicePixelRatio` is applied (SS9): the backing store is
    // device pixels, the CSS box is CSS pixels, and the context is pre-scaled
    // so every layer can draw in CSS pixels only.
    const deviceW = Math.max(1, Math.round(widthPx * dpr));
    const deviceH = Math.max(1, Math.round(heightPx * dpr));
    if (slot.canvas.width !== deviceW) slot.canvas.width = deviceW;
    if (slot.canvas.height !== deviceH) slot.canvas.height = deviceH;
    slot.canvas.style.width = `${String(widthPx)}px`;
    slot.canvas.style.height = `${String(heightPx)}px`;
    slot.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  for (const slot of slots) applyCanvasSize(slot);

  let frameHandle: number | null = null;

  const drawSlot = (slot: LayerSlot, time: number): void => {
    slot.dirty = false;
    const { ctx } = slot;
    ctx.save();
    // Clearing in device space is the only place the transform is bypassed.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame: LayerFrame = { ctx, viewport, widthPx, heightPx, dpr, time };
    try {
      slot.layer.draw(frame);
    } finally {
      // Defensive: a layer that leaks ctx state cannot corrupt the next one.
      ctx.restore();
    }
  };

  const drawDirty = (time: number): void => {
    // In LAYER_ORDER, bottom to top, at most once each per frame.
    for (const kind of LAYER_ORDER) {
      for (const slot of slots) {
        if (slot.layer.kind === kind && slot.dirty) drawSlot(slot, time);
      }
    }
    // Any layer kind outside LAYER_ORDER (there is none in M1) still draws.
    for (const slot of slots) {
      if (slot.dirty) drawSlot(slot, time);
    }
  };

  const schedule = (): void => {
    if (disposed || frameHandle !== null) return;
    frameHandle = requestFrame((time) => {
      frameHandle = null;
      drawDirty(time);
    });
  };

  const markDirty = (kinds: readonly LayerKind[]): void => {
    let any = false;
    for (const slot of slots) {
      if (kinds.includes(slot.layer.kind)) {
        slot.dirty = true;
        any = true;
      }
    }
    if (any) schedule();
  };

  const renderer: Renderer = {
    element,
    get dpr() {
      return dpr;
    },
    get widthPx() {
      return widthPx;
    },
    get heightPx() {
      return heightPx;
    },

    invalidate(kind: LayerKind | readonly LayerKind[]): void {
      markDirty(typeof kind === "string" ? [kind] : kind);
    },

    invalidateAll(): void {
      markDirty(LAYER_ORDER);
    },

    resize(nextWidthPx: number, nextHeightPx: number): void {
      const nextDpr = resolveDpr(options.dpr);
      if (
        nextWidthPx === widthPx &&
        nextHeightPx === heightPx &&
        nextDpr === dpr
      ) {
        return;
      }
      widthPx = Math.max(0, nextWidthPx);
      heightPx = Math.max(0, nextHeightPx);
      dpr = nextDpr;
      for (const slot of slots) applyCanvasSize(slot);
      renderer.invalidateAll();
    },

    flush(): void {
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      drawDirty(typeof performance === "undefined" ? Date.now() : performance.now());
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeViewport();
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      for (const slot of slots) slot.layer.dispose?.();
      element.remove();
    },
  };

  // SS9's redraw triggers: a viewport change is an input to grid AND content
  // (and to the overlay, whose ghosts are positioned in the same transform).
  // A DATA change, by contrast, is the editor's own `invalidate('content')` —
  // which is exactly why the grid layer survives a 2,000-note edit untouched.
  const unsubscribeViewport = viewport.onChange(() => {
    renderer.invalidateAll();
  });

  // Every layer starts dirty: the first frame paints the whole stack.
  schedule();

  return renderer;
};
