// Coordinate + modifier normalization at the DOM boundary.
//
// SS15: "gesture FSMs are unit-tested by feeding synthetic pointer-event
// sequences" — so nothing downstream of this file ever sees a DOM event. This
// is the ONLY place that reads `PointerEvent`/`KeyboardEvent` fields.

import type {
  EditorPoint,
  KeyInput,
  Modifiers,
  PointerInput,
  WheelInput,
} from "../../types/gesture";
import type { Viewport } from "../../types/viewport";

export const NO_MODIFIERS: Modifiers = Object.freeze({
  shift: false,
  alt: false,
  ctrl: false,
  meta: false,
  primary: false,
});

/** Convenience for tests and key bindings: `modifiers({ alt: true })`. */
export function modifiers(overrides: Partial<Modifiers> = {}): Modifiers {
  const merged = { ...NO_MODIFIERS, ...overrides };
  // Keep `primary` consistent when a caller only sets `meta`/`ctrl`.
  if (overrides.primary === undefined) {
    merged.primary = isApplePlatform() ? merged.meta : merged.ctrl;
  }
  return merged;
}

let applePlatform: boolean | null = null;

/** `primary` is Cmd on macOS and Ctrl everywhere else (SS10's `Cmd/Ctrl+D`). */
export function isApplePlatform(): boolean {
  if (applePlatform !== null) return applePlatform;
  const nav: { platform?: string; userAgent?: string } | undefined =
    typeof navigator === "undefined" ? undefined : navigator;
  const probe = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  applePlatform = /mac|iphone|ipad|ipod/i.test(probe);
  return applePlatform;
}

/** Test seam: pins the platform so `primary` is deterministic. */
export function setApplePlatform(value: boolean | null): void {
  applePlatform = value;
}

interface ModifierBearing {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export function modifiersOf(event: ModifierBearing): Modifiers {
  return {
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    primary: isApplePlatform() ? event.metaKey : event.ctrlKey,
  };
}

/**
 * The one place CSS pixels become musical units. `tick` is an integer (SS8)
 * and `row` is fractional (the frozen row convention).
 */
export function editorPointOf(
  viewport: Viewport,
  xPx: number,
  yPx: number,
): EditorPoint {
  return {
    xPx,
    yPx,
    tick: viewport.tAt(xPx),
    row: viewport.rowAt(yPx),
  };
}

/** Client coordinates -> content-origin CSS pixels for `element`. */
export function elementPointOf(
  element: HTMLElement,
  viewport: Viewport,
  clientX: number,
  clientY: number,
): EditorPoint {
  const rect = element.getBoundingClientRect();
  return editorPointOf(viewport, clientX - rect.left, clientY - rect.top);
}

export function pointerInputOf(
  element: HTMLElement,
  viewport: Viewport,
  event: PointerEvent,
  clickCount?: number,
): PointerInput {
  return {
    pointerId: event.pointerId,
    point: elementPointOf(element, viewport, event.clientX, event.clientY),
    button: event.button,
    buttons: event.buttons,
    modifiers: modifiersOf(event),
    clickCount,
    native: event,
  };
}

// --- click counting ---------------------------------------------------------

// `PointerEvent.detail` CANNOT be used for this. The Pointer Events spec fixes
// `detail` at 0 on `pointerdown`/`pointerup` — click counting belongs to the
// `MouseEvent` `click`/`dblclick` family, which the engine deliberately does
// not listen to (SS9: one FSM over pointer events). Reading `detail` here
// makes `clickCount` permanently 1, and every double-click verb — SS10's
// "double-click a clip to open it in the piano roll" chief among them —
// silently unreachable. So the kit counts clicks itself, from the same
// timing/proximity rule the platform uses.

/** Two downs further apart than this in time are separate clicks. */
export const MULTI_CLICK_MS = 500;
/** ...and so are two downs further apart than this in CSS pixels. */
export const MULTI_CLICK_SLOP_PX = 5;

export interface ClickCounter {
  /** Call once per `pointerdown`: returns 1 for a single click, 2 for a
   *  double, 3 for a triple, and so on. */
  register(event: PointerEvent): number;
  /** Forget the streak (e.g. on detach), so the next down counts as 1. */
  reset(): void;
}

/**
 * One counter per bound element. A streak continues only while the downs stay
 * close in time AND position AND use the same button and pointer type — the
 * position test is what keeps a fast drag-click-elsewhere from reading as a
 * double-click.
 */
export function createClickCounter(now: () => number = defaultNow): ClickCounter {
  let count = 0;
  let lastTime = Number.NEGATIVE_INFINITY;
  let lastX = 0;
  let lastY = 0;
  let lastButton = -1;
  let lastPointerType: string | undefined;

  return {
    register(event: PointerEvent): number {
      const time = now();
      const continues =
        time - lastTime <= MULTI_CLICK_MS &&
        Math.abs(event.clientX - lastX) <= MULTI_CLICK_SLOP_PX &&
        Math.abs(event.clientY - lastY) <= MULTI_CLICK_SLOP_PX &&
        event.button === lastButton &&
        event.pointerType === lastPointerType;

      count = continues ? count + 1 : 1;
      lastTime = time;
      lastX = event.clientX;
      lastY = event.clientY;
      lastButton = event.button;
      lastPointerType = event.pointerType;
      return count;
    },

    reset(): void {
      count = 0;
      lastTime = Number.NEGATIVE_INFINITY;
    },
  };
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function wheelInputOf(
  element: HTMLElement,
  viewport: Viewport,
  event: WheelEvent,
): WheelInput {
  // Browsers report a trackpad pinch as a wheel event with `ctrlKey` set and
  // no key actually held; the engine treats both the same way anyway.
  return {
    deltaX: normalizeWheelDelta(event.deltaX, event.deltaMode),
    deltaY: normalizeWheelDelta(event.deltaY, event.deltaMode),
    point: elementPointOf(element, viewport, event.clientX, event.clientY),
    modifiers: modifiersOf(event),
    pinch: event.ctrlKey,
  };
}

/** DOM_DELTA_LINE / DOM_DELTA_PAGE -> pixels, so zoom feel is device-uniform. */
function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 400;
  return delta;
}

export function keyInputOf(event: KeyboardEvent): KeyInput {
  return {
    key: event.key,
    code: event.code,
    modifiers: modifiersOf(event),
    repeat: event.repeat,
  };
}
