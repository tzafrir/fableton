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

/**
 * The kit's own extension of the frozen `GestureEngineOptions`.
 *
 * `rowOriginPx` is the offset from the element's top edge to row 0 of the
 * viewport's row axis. It is 0 for an editor whose canvas IS the row area
 * (the arrangement, whose ruler lives in its own grid cell) and
 * `RULER_HEIGHT_PX` for the piano roll, which draws its ruler inside the same
 * canvas stack. Only the row zoom anchor needs it: without it,
 * `Ctrl/Cmd+Shift+wheel` zooms about a pitch other than the one under the
 * cursor, which is not the "keeps the value under cursor fixed" SS9 asks for.
 */
export interface KitGestureEngineOptions<THit extends HitTarget = HitTarget>
  extends GestureEngineOptions<THit> {
  rowOriginPx?: number | (() => number) | undefined;
}

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
  /** The CONTENT the gesture grabbed, frozen at pointerdown: a fractional
   *  tick and a fractional row, not the pixel they were under. Deltas are
   *  measured from here (see `buildUpdate`), which is what keeps a ghost
   *  under the pointer when the viewport scrolls or zooms mid-drag. */
  readonly startTick: number;
  readonly startRow: number;
  point: EditorPoint;
  preview: unknown;
  dragging: boolean;
}

/**
 * The kit's factory. Identical to `CreateGestureEngine` except that it hands
 * back the `KitGestureEngine` widening, which the kit's overlay layer needs.
 */
export function createKitGestureEngine<THit extends HitTarget>(
  options: KitGestureEngineOptions<THit>,
): KitGestureEngine<THit> {
  const viewport: Viewport = options.viewport;
  const grid: Grid = options.grid;
  const element = options.element;
  /** Distance from the element top to the row axis origin — see
   *  `KitGestureEngineOptions.rowOriginPx`. */
  const rowOriginPx = (): number => {
    const origin = options.rowOriginPx;
    return typeof origin === "function" ? origin() : (origin ?? 0);
  };

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

  // --- two-pointer pan/zoom (SS2: "touch gets basics (pan/zoom/select)") ----
  //
  // `touch-action: none` on the element hands the browser's own pan/zoom to
  // this FSM, so the FSM has to provide it: a second pointer cancels whatever
  // drag was live (zero document traffic, exactly like `Esc`) and the pair
  // then drives SS9's uniform scroll/zoom — pinch = zoom-to-cursor on the time
  // axis, centroid movement = pan. `wheelInputOf`'s `pinch` flag covers only
  // the TRACKPAD flavour, which the browser reports as a ctrl-wheel.
  const livePointers = new Map<number, { xPx: number; yPx: number }>();
  interface PinchState {
    a: number;
    b: number;
    distPx: number;
    centroidXPx: number;
    centroidYPx: number;
  }
  let pinch: PinchState | null = null;

  const pinchGeometry = (a: number, b: number): PinchState | null => {
    const pa = livePointers.get(a);
    const pb = livePointers.get(b);
    if (pa === undefined || pb === undefined) return null;
    return {
      a,
      b,
      distPx: Math.hypot(pa.xPx - pb.xPx, pa.yPx - pb.yPx),
      centroidXPx: (pa.xPx + pb.xPx) / 2,
      centroidYPx: (pa.yPx + pb.yPx) / 2,
    };
  };

  const endPinch = (): void => {
    pinch = null;
  };

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

  /** Fractional tick under a content-origin pixel, at the CURRENT transform. */
  const exactTickAt = (xPx: number): number => viewport.scrollTicks + xPx / viewport.pxPerTick;

  const buildUpdate = (point: EditorPoint, mods: PointerInput["modifiers"]): DragUpdate<THit, unknown> => {
    const a = active as ActiveGesture<THit>;
    const dx = point.xPx - a.start.point.xPx;
    const dy = point.yPx - a.start.point.yPx;
    // SS9's coordinate discipline: the delta is measured in MUSICAL units,
    // from the content the gesture grabbed to the content under the pointer
    // now. Both ends are re-read through the live viewport, so a scroll or a
    // zoom mid-drag moves the ghost with the pointer instead of stranding it
    // at a stale pixel offset. With a still viewport this is exactly
    // `tickDeltaOf(dx)`: one rounding, on the total delta.
    const deltaTicks = exactTickAt(point.xPx) - a.startTick;
    const deltaRows = viewport.rowAt(point.yPx) - a.startRow;
    return {
      start: a.start,
      point,
      modifiers: mods,
      deltaPx: { x: dx, y: dy },
      deltaTicks: Math.round(deltaTicks) === 0 ? 0 : Math.round(deltaTicks),
      deltaRows: deltaRows === 0 ? 0 : deltaRows,
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
      if (disposed) return;
      livePointers.set(input.pointerId, { xPx: input.point.xPx, yPx: input.point.yPx });
      if (pinch !== null) return;
      if (livePointers.size >= 2) {
        // A second finger: abandon the one-finger verb (no command, SS9's
        // "zero document traffic") and pan/zoom with the pair instead.
        const ids = [...livePointers.keys()];
        const a = ids[ids.length - 2] as number;
        const b = ids[ids.length - 1] as number;
        engine.cancel();
        pinch = pinchGeometry(a, b);
        return;
      }
      if (active !== null) return;
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

      active = {
        handler,
        start,
        startTick: exactTickAt(input.point.xPx),
        startRow: viewport.rowAt(input.point.yPx),
        point: input.point,
        preview: null,
        dragging: false,
      };
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
      if (livePointers.has(input.pointerId)) {
        livePointers.set(input.pointerId, { xPx: input.point.xPx, yPx: input.point.yPx });
      }
      if (pinch !== null) {
        const next = pinchGeometry(pinch.a, pinch.b);
        if (next === null) {
          endPinch();
          return;
        }
        // Pan first (both axes), then zoom about the pinch centre — SS9's
        // "zoom-to-cursor", with the centroid standing in for the cursor.
        viewport.scrollBy(pinch.centroidXPx - next.centroidXPx, pinch.centroidYPx - next.centroidYPx);
        if (pinch.distPx > 0 && next.distPx > 0) {
          viewport.zoomAt(next.centroidXPx, next.distPx / pinch.distPx);
        }
        pinch = next;
        notify();
        return;
      }
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
      if (disposed) return;
      livePointers.delete(input.pointerId);
      if (pinch !== null) {
        if (input.pointerId === pinch.a || input.pointerId === pinch.b) endPinch();
        return;
      }
      if (active === null) return;
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
      if (disposed) return;
      livePointers.delete(input.pointerId);
      if (pinch !== null) {
        if (input.pointerId === pinch.a || input.pointerId === pinch.b) endPinch();
        return;
      }
      if (active === null) return;
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
        // SS9's zoom-to-cursor is anchored on the ROW under the pointer, and
        // an editor may draw a ruler inside the same canvas stack (the piano
        // roll does), so the row axis origin is not always the element top.
        if (input.modifiers.shift) viewport.zoomRowsAt(input.point.yPx - rowOriginPx(), factor);
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
      // SS9: "every drag ... commits exactly one command on release", and
      // SS10's drag rows give the drag states exactly one key column (`Esc`).
      // A key binding that fired mid-gesture would dispatch a SECOND command
      // for the same gesture, computed from geometry the live preview has
      // already moved past (and `Delete` would delete the very notes the
      // ghost is tracking). While a gesture is live the kit swallows every
      // key but `Esc`.
      if (active !== null) return true;
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
      endPinch();
      livePointers.clear();
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

    /** A completed drag ENDS the multi-click streak (SS10's `Pending` row
     *  gives a single click exactly one meaning). Without this, a marquee or
     *  move drag that releases within `MULTI_CLICK_SLOP_PX` of where it
     *  started — or any drag followed by a click near its origin inside
     *  `MULTI_CLICK_MS` — makes the NEXT single click read as a double click
     *  and fire a creation verb ("dbl-click empty: create...") the user never
     *  asked for, i.e. an undoable edit from a plain click. */
    const breakClickStreakOnDrag = (): void => {
      if (phase === "dragging") clicks.reset();
    };

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
      // A `thresholdPx: 0` verb (the pencil) is already dragging here.
      breakClickStreakOnDrag();
    };
    const onPointerMove = (e: PointerEvent): void => {
      engine.pointerMove(pointerInputOf(element, viewport, e));
      breakClickStreakOnDrag();
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
      if (!engine.keyDown(keyInputOf(e))) return;
      e.preventDefault();
      // The kit consumed this key, so nothing outside the editor may act on
      // it. This is what makes the swallow-everything-but-Esc rule above real:
      // the app shell binds undo/redo GLOBALLY (SS13's command bus, on
      // `window`), and a keydown that merely had `preventDefault()` called on
      // it still bubbles out of the host and would undo the document in the
      // MIDDLE of a live drag — a second document mutation for one gesture,
      // against which the ghosts and the committed delta are then stale.
      e.stopPropagation();
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
