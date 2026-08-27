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
): PointerInput {
  return {
    pointerId: event.pointerId,
    point: elementPointOf(element, viewport, event.clientX, event.clientY),
    button: event.button,
    buttons: event.buttons,
    modifiers: modifiersOf(event),
    clickCount: event.detail === 0 ? 1 : event.detail,
    native: event,
  };
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
