// SS9 — "The kit runs one FSM per editor over pointer events; editors register
// hit-testers and drag handlers. Every drag operates on a PREVIEW (ghosts in
// the overlay) and commits exactly one command on release; `Esc` aborts with
// zero document traffic. This is what makes editing feel native: thresholds,
// capture, snapping, and cancellation live in one tested place."
//
// SS10's state table collapses to three phases; the per-verb behaviour is
// whatever the registered `DragHandler` says:
//
//   idle    --pointerdown (a handler claims)-->  pending
//   pending --move > threshold-->                dragging      (begin)
//   pending --up-->                              idle          (click)
//   dragging--move-->                            dragging      (update)
//   dragging--up-->                              idle          (commit: 1 cmd)
//   any     --Esc / pointercancel-->             idle          (cancel: 0 cmds)
//
// Rules the engine enforces so no editor can break them:
//   * AT MOST ONE command per gesture, dispatched from `commit`/`click` only.
//   * `cancel` dispatches NOTHING — "zero document traffic".
//   * `update` never touches the document; it returns a new preview and the
//     engine invalidates the OVERLAY layer only (SS9's layer discipline).
//   * wheel bindings are uniform across editors and live here, not in editors.
//
// SS15: every input method takes a PLAIN OBJECT, so the whole FSM runs
// headless under Vitest with synthetic pointer sequences.

import type { Unsub } from "../../types/common";
import type { Command } from "../../types/commands";
import type {
  ClickInfo,
  CreateGestureEngine,
  DragHandler,
  DragUpdate,
  EditorPoint,
  GestureEngine,
  GestureEngineOptions,
  GesturePhase,
  GestureStart,
  HitTarget,
  HitTester,
  KeyBinding,
  KeyInput,
  PointerInput,
  WheelInput,
} from "../../types/gesture";
import { DRAG_THRESHOLD_PX } from "../../types/gesture";
import type { LayerFrame } from "../../types/render";
import type { Grid, Viewport } from "../../types/viewport";
import {
  createClickCounter,
  editorPointOf,
  keyInputOf,
  pointerInputOf,
  wheelInputOf,
} from "./points";

/** Cursor when nothing is hovered and no drag is live. */
export const DEFAULT_CURSOR = "default";

/**
 * Wheel notches -> zoom factor. `exp(-delta * k)`: symmetric (one notch in and
 * one notch out return exactly to the starting zoom) and framerate-free.
 */
export const ZOOM_WHEEL_SENSITIVITY = 0.0025;

/** The kit's own extension of the frozen `GestureEngine` contract. */
export interface KitGestureEngine<THit extends HitTarget = HitTarget>
  extends GestureEngine<THit> {
  /** Lets the kit's overlay layer draw the ACTIVE handler's ghosts (SS9). */
  drawActivePreview(frame: LayerFrame): void;
}

interface Registration<T> {
  readonly item: T;
  readonly seq: number;
}

/** Priority desc, registration order asc — a stable, explainable order. */
function ordered<T extends { readonly priority?: number | undefined }>(
  registrations: readonly Registration<T>[],
): T[] {
  return [...registrations]
    .sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0) || a.seq - b.seq)
    .map((r) => r.item);
}

type AnyHandler<THit extends HitTarget> = DragHandler<THit, unknown>;

interface ActiveGesture<THit extends HitTarget> {
  readonly handler: AnyHandler<THit>;
  readonly start: GestureStart<THit>;
  point: EditorPoint;
  preview: unknown;
  dragging: boolean;
}

/**
 * The kit's factory. Identical to `CreateGestureEngine` except that it hands
 * back the `KitGestureEngine` widening, which the kit's overlay layer needs.
 */
export function createKitGestureEngine<THit extends HitTarget>(
  options: GestureEngineOptions<THit>,
): KitGestureEngine<THit> {
  const viewport: Viewport = options.viewport;
  const grid: Grid = options.grid;
  const element = options.element;

  let seq = 0;
  const hitTesters: Registration<HitTester<THit>>[] = [];
  const dragHandlers: Registration<AnyHandler<THit>>[] = [];
  const keyBindings: Registration<KeyBinding>[] = [];
  for (const t of options.hitTesters ?? []) hitTesters.push({ item: t, seq: seq++ });
  for (const h of options.dragHandlers ?? []) {
    dragHandlers.push({ item: h as AnyHandler<THit>, seq: seq++ });
  }
  for (const b of options.keyBindings ?? []) keyBindings.push({ item: b, seq: seq++ });

  let phase: GesturePhase = "idle";
  let hover: THit | null = null;
  let cursor: string = DEFAULT_CURSOR;
  let active: ActiveGesture<THit> | null = null;
  let disposed = false;

  const listeners = new Set<(engine: GestureEngine<THit>) => void>();
  const notify = (): void => {
    for (const cb of [...listeners]) cb(engine);
  };
  const invalidateOverlay = (): void => {
    options.invalidateOverlay?.();
  };

  const hitTest = (point: EditorPoint, mods: PointerInput["modifiers"]): THit | null => {
    for (const tester of ordered(hitTesters)) {
      const hit = tester.hitTest(point, mods);
      if (hit !== null) return hit;
    }
    return null;
  };

  const cursorFor = (): string => {
    if (active !== null) {
      return active.handler.cursor ?? active.start.hit.cursor ?? DEFAULT_CURSOR;
    }
    return hover?.cursor ?? DEFAULT_CURSOR;
  };

  const setHover = (next: THit | null): void => {
    const changed = next !== hover;
    hover = next;
    const nextCursor = cursorFor();
    const cursorChanged = nextCursor !== cursor;
    cursor = nextCursor;
    if (changed || cursorChanged) {
      applyCursor();
      invalidateOverlay();
      notify();
    }
  };

  const applyCursor = (): void => {
    if (element) element.style.cursor = cursor;
  };

  const dispatchOne = (command: Command | null): void => {
    if (command === null) return;
    options.dispatch(command);
  };

  const buildUpdate = (point: EditorPoint, mods: PointerInput["modifiers"]): DragUpdate<THit, unknown> => {
    const a = active as ActiveGesture<THit>;
    const dx = point.xPx - a.start.point.xPx;
    const dy = point.yPx - a.start.point.yPx;
    return {
      start: a.start,
      point,
      modifiers: mods,
      deltaPx: { x: dx, y: dy },
      // Rounded ONCE on the total pixel delta (see viewport.tickDeltaOf), so
      // a slow drag and a fast drag over the same distance agree exactly.
      deltaTicks: viewport.tickDeltaOf(dx),
      deltaRows: viewport.rowDeltaOf(dy),
      preview: a.preview,
      viewport,
      grid,
    };
  };

  const releaseCapture = (pointerId: number): void => {
    if (!element) return;
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      // Capture is best-effort; a lost capture is handled by `pointerCancel`.
    }
  };

  /** Ends the gesture without dispatching anything. */
  const reset = (): void => {
    active = null;
    phase = "idle";
    cursor = cursorFor();
    applyCursor();
  };

  const promote = (point: EditorPoint, mods: PointerInput["modifiers"]): void => {
    const a = active as ActiveGesture<THit>;
    a.dragging = true;
    phase = "dragging";
    a.preview = a.handler.begin(a.start);
    a.point = point;
    // Feed the promoting move straight through, so the ghost appears under the
    // pointer on the very first dragging frame instead of one frame late.
    a.preview = a.handler.update(buildUpdate(point, mods));
    cursor = cursorFor();
    applyCursor();
    invalidateOverlay();
    notify();
  };

  const engine: KitGestureEngine<THit> = {
    get phase() {
      return phase;
    },
    get hover() {
      // A live drag owns the pointer; hover highlighting is meaningless then.
      return phase === "idle" ? hover : null;
    },
    get cursor() {
      return cursor;
    },
    get activeHandlerId() {
      return active?.handler.id ?? null;
    },
    get preview() {
      return active !== null && active.dragging ? active.preview : null;
    },

    registerHitTester(tester: HitTester<THit>): Unsub {
      const reg: Registration<HitTester<THit>> = { item: tester, seq: seq++ };
      hitTesters.push(reg);
      return () => {
        const i = hitTesters.indexOf(reg);
        if (i >= 0) hitTesters.splice(i, 1);
      };
    },

    registerDragHandler<TPreview>(handler: DragHandler<THit, TPreview>): Unsub {
      const reg: Registration<AnyHandler<THit>> = {
        item: handler as unknown as AnyHandler<THit>,
        seq: seq++,
      };
      dragHandlers.push(reg);
      return () => {
        const i = dragHandlers.indexOf(reg);
        if (i >= 0) dragHandlers.splice(i, 1);
      };
    },

    registerKeyBinding(binding: KeyBinding): Unsub {
      const reg: Registration<KeyBinding> = { item: binding, seq: seq++ };
      keyBindings.push(reg);
      return () => {
        const i = keyBindings.indexOf(reg);
        if (i >= 0) keyBindings.splice(i, 1);
      };
    },

    pointerDown(input: PointerInput): void {
      if (disposed || active !== null) return;
      const hit = hitTest(input.point, input.modifiers);
      // No hit means no verb: editors register a catch-all ("empty") tester
      // when the background is itself a target (SS10 marquee).
      if (hit === null) return;

      const start: GestureStart<THit> = {
        hit,
        point: input.point,
        modifiers: input.modifiers,
        pointerId: input.pointerId,
        button: input.button,
        clickCount: input.clickCount ?? 1,
        viewport,
        grid,
      };

      const handler = ordered(dragHandlers).find((h) => h.claim(start));
      if (handler === undefined) return;

      active = { handler, start, point: input.point, preview: null, dragging: false };
      phase = "pending";
      hover = null;
      if (element) {
        try {
          element.setPointerCapture(input.pointerId);
        } catch {
          // Synthetic/headless pointers have nothing to capture.
        }
      }
      cursor = cursorFor();
      applyCursor();

      // `thresholdPx: 0` means "this verb IS the pointerdown" (pencil paint).
      if ((handler.thresholdPx ?? DRAG_THRESHOLD_PX) <= 0) {
        promote(input.point, input.modifiers);
        return;
      }
      notify();
    },

    pointerMove(input: PointerInput): void {
      if (disposed) return;
      if (active === null) {
        setHover(hitTest(input.point, input.modifiers));
        return;
      }
      if (input.pointerId !== active.start.pointerId) return;

      if (!active.dragging) {
        const dx = input.point.xPx - active.start.point.xPx;
        const dy = input.point.yPx - active.start.point.yPx;
        const threshold = active.handler.thresholdPx ?? DRAG_THRESHOLD_PX;
        // SS9: "a drag is promoted after MORE THAN this much travel".
        if (Math.hypot(dx, dy) <= threshold) {
          active.point = input.point;
          return;
        }
        promote(input.point, input.modifiers);
        return;
      }

      active.point = input.point;
      active.preview = active.handler.update(buildUpdate(input.point, input.modifiers));
      invalidateOverlay();
      notify();
    },

    pointerUp(input: PointerInput): void {
      if (disposed || active === null) return;
      if (input.pointerId !== active.start.pointerId) return;
      const a = active;
      releaseCapture(input.pointerId);

      if (!a.dragging) {
        // SS10 `Pending` -> released under the threshold: a click, not a drag.
        const info: ClickInfo = {
          clickCount: input.clickCount ?? a.start.clickCount,
          modifiers: input.modifiers,
        };
        reset();
        dispatchOne(a.handler.click?.(a.start, info) ?? null);
        invalidateOverlay();
        setHover(hitTest(input.point, input.modifiers));
        notify();
        return;
      }

      // Refresh the preview at the release point, then commit exactly once.
      const refresh = buildUpdate(input.point, input.modifiers);
      a.preview = a.handler.update(refresh);
      const final: DragUpdate<THit, unknown> = { ...refresh, preview: a.preview };
      reset();
      dispatchOne(a.handler.commit(final));
      invalidateOverlay();
      setHover(hitTest(input.point, input.modifiers));
      notify();
    },

    pointerCancel(input: PointerInput): void {
      if (disposed || active === null) return;
      if (input.pointerId !== active.start.pointerId) return;
      engine.cancel();
    },

    wheel(input: WheelInput): boolean {
      if (disposed) return false;
      // SS9, uniform across every editor: wheel = vertical, Shift+wheel =
      // horizontal, Ctrl/Cmd+wheel and pinch = zoom-to-cursor.
      const zoom = input.pinch === true || input.modifiers.ctrl || input.modifiers.meta;
      if (zoom) {
        const factor = Math.exp(-input.deltaY * ZOOM_WHEEL_SENSITIVITY);
        if (input.modifiers.shift) viewport.zoomRowsAt(input.point.yPx, factor);
        else viewport.zoomAt(input.point.xPx, factor);
      } else if (input.modifiers.shift) {
        // Shift+wheel: the vertical notch drives the horizontal axis. Some
        // platforms already swap the axes, so fall back to deltaX.
        const delta = input.deltaY !== 0 ? input.deltaY : input.deltaX;
        viewport.scrollBy(delta, 0);
      } else {
        viewport.scrollBy(input.deltaX, input.deltaY);
      }
      // The content under a live drag just moved; re-derive the preview from
      // the same screen position so the ghost stays under the pointer.
      if (active !== null && active.dragging) {
        const point = editorPointOf(viewport, active.point.xPx, active.point.yPx);
        active.point = point;
        active.preview = active.handler.update(buildUpdate(point, input.modifiers));
        invalidateOverlay();
        notify();
      }
      return true;
    },

    keyDown(input: KeyInput): boolean {
      if (disposed) return false;
      // Esc during a gesture aborts it and is consumed here; in `idle` it
      // falls through so the editor's own binding can clear the selection.
      if (input.key === "Escape" && active !== null) {
        engine.cancel();
        return true;
      }
      for (const binding of ordered(keyBindings)) {
        const outcome = binding.handle(input);
        if (outcome === null) continue;
        dispatchOne(outcome.command ?? null);
        return outcome.preventDefault ?? true;
      }
      return false;
    },

    cancel(): void {
      if (active === null) return;
      const a = active;
      releaseCapture(a.start.pointerId);
      reset();
      // Zero document traffic: `cancel` is the only exit that dispatches
      // nothing, and it runs AFTER the FSM is already back in `idle` so a
      // handler cannot re-enter.
      if (a.dragging) a.handler.cancel(a.preview, a.start);
      invalidateOverlay();
      notify();
    },

    drawActivePreview(frame: LayerFrame): void {
      if (active === null || !active.dragging) return;
      active.handler.drawPreview?.(frame, active.preview);
    },

    onChange(cb: (e: GestureEngine<THit>) => void): Unsub {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    dispose(): void {
      if (disposed) return;
      engine.cancel();
      disposed = true;
      detach();
      listeners.clear();
      hitTesters.length = 0;
      dragHandlers.length = 0;
      keyBindings.length = 0;
    },
  };

  // --- optional DOM binding -------------------------------------------------

  let detach = (): void => {};

  if (element) {
    // Click counting is the binding's job, not the event's: see
    // `createClickCounter` for why `PointerEvent.detail` is unusable here.
    // Only `pointerdown` advances the streak; the other phases leave
    // `clickCount` undefined and the FSM carries the gesture's start value.
    const clicks = createClickCounter();

    const onPointerDown = (e: PointerEvent): void => {
      // MUST come before anything else. Without it Chrome treats the
      // pointerdown as the start of one of its own default gestures (text
      // selection / native drag), takes the pointer away from the page and
      // fires `pointercancel` on this element immediately after the
      // pointerdown handler returns — no `pointermove`, no `pointerup`, ever.
      // Every drag in every editor then aborts through `cancel()` a frame
      // after it starts, so nothing ever commits: SS9's "commits exactly one
      // command on release" can never be reached. `setPointerCapture` does
      // NOT prevent this, and neither does `touch-action: none` (that governs
      // touch scrolling, not the mouse). Focus is taken explicitly below
      // because `preventDefault` also suppresses the default focus behavior.
      e.preventDefault();
      element.focus?.();
      engine.pointerDown(pointerInputOf(element, viewport, e, clicks.register(e)));
    };
    const onPointerMove = (e: PointerEvent): void => {
      engine.pointerMove(pointerInputOf(element, viewport, e));
    };
    const onPointerUp = (e: PointerEvent): void => {
      engine.pointerUp(pointerInputOf(element, viewport, e));
    };
    const onPointerCancel = (e: PointerEvent): void => {
      engine.pointerCancel(pointerInputOf(element, viewport, e));
    };
    const onPointerLeave = (e: PointerEvent): void => {
      if (phase === "idle") setHover(null);
      else engine.pointerMove(pointerInputOf(element, viewport, e));
    };
    const onWheel = (e: WheelEvent): void => {
      if (engine.wheel(wheelInputOf(element, viewport, e))) e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (engine.keyDown(keyInputOf(e))) e.preventDefault();
    };
    const onLostCapture = (e: PointerEvent): void => {
      engine.pointerCancel(pointerInputOf(element, viewport, e));
    };
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
    };

    // Pointer events only — `touch-action: none` keeps the browser from
    // stealing a drag for native panning.
    element.style.touchAction = "none";
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("lostpointercapture", onLostCapture);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("contextmenu", onContextMenu);

    detach = () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerCancel);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("lostpointercapture", onLostCapture);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("contextmenu", onContextMenu);
    };
  }

  return engine;
}

/** The frozen contract's factory shape (src/types/gesture.ts). */
export const createGestureEngine: CreateGestureEngine = createKitGestureEngine;
