// SS5 — the ONE control gesture spec, headless.
//
// "What matters is that the gesture spec is defined once, in one place, and
// every control inherits it." This module is that place: a plain state
// machine over pointer/wheel/key inputs bound to a `ParamHandle`, with no
// DOM and no React — the components in this directory are thin views over
// it, and the tests drive it with synthetic events (SS15).
//
// The spec rows implemented here (SS5 table):
//   drag        150 px of vertical travel = full sweep through the taper;
//               relative (no jump-to-click-point); pointer capture is the
//               VIEW's job, `Esc` mid-drag reverts with no undo entry.
//   Shift       fine mode x0.1, enter/exit MID-DRAG with re-anchoring —
//               no value jumps on the modifier edge.
//   wheel       1% of sweep per notch, Shift = 0.1%. The view routes wheel
//               events only while the control is FOCUSED — SS5 says "while
//               hovering", but a device chain scrolls under its own knobs,
//               and hover-only meant a trackpad flick aimed at the panel
//               stopped dead on a knob and moved it. See ParamControl.tsx.
//   keys        arrows 1%, Shift+arrows 0.1%, PgUp/PgDn 10%.
//   reset       Alt+click / Delete -> defaultValue (one commit).
//   commit      exactly one `handle.commit()` per gesture (SS4).
//
// Stepped/enum/toggle kinds quantize through the taper's `clamp`, so a
// stepped knob detents and a toggle flips — same machine, no special cases.

import type { ParamHandle } from "../../types";
import { fromNormalized, toNormalized, clampToDescriptor } from "../../params/taper";

/** SS5: "150 px of travel = full sweep through the param's taper". */
export const DRAG_FULL_SWEEP_PX = 150;
/** SS5 fine mode multiplier. */
export const FINE_FACTOR = 0.1;
/** SS5 wheel step: 1% of sweep (0.1% fine). */
export const WHEEL_STEP = 0.01;
export const KEY_STEP = 0.01;
export const PAGE_STEP = 0.1;

export interface ControlDragState {
  /** Normalized position the current segment is anchored at. */
  anchorNormalized: number;
  /** Pointer y at the anchor (CSS px). */
  anchorY: number;
  fine: boolean;
  /** Value when the whole gesture started — what `Esc` restores. */
  startValue: number;
  active: boolean;
}

/**
 * The headless control core. The view calls these from its event handlers;
 * `onDisplay` fires whenever the shown value should repaint (the handle's
 * own `onChange` covers automation-driven motion separately).
 */
export interface ControlGesture {
  readonly dragging: boolean;
  dragStart(y: number, fine: boolean): void;
  dragMove(y: number, fine: boolean): void;
  /** Commits (one undo entry) and ends the gesture. */
  dragEnd(): void;
  /** SS5 `Esc` mid-drag: revert to the pre-drag value, NO undo entry. */
  dragCancel(): void;
  /** Wheel notch: `delta` in wheel units (+1 = one notch away from you). */
  wheel(deltaNotches: number, fine: boolean): void;
  /** Keyboard step; `sign` +1/-1, `page` for PgUp/PgDn. Commits per press. */
  keyStep(sign: 1 | -1, options?: { fine?: boolean; page?: boolean }): void;
  /** SS5 reset: Alt+click / Delete. One commit. */
  reset(): void;
  /** Text entry commit (`fromText` already parsed by the caller). */
  setFromText(text: string): boolean;
}

export function createControlGesture(handle: ParamHandle): ControlGesture {
  const desc = handle.desc;
  let drag: ControlDragState | null = null;

  const setLiveClamped = (value: number): void => {
    handle.setLive(clampToDescriptor(desc, value), "user");
  };

  // SS5 "Stepped knob: wheel steps whole increments" — and an enum/toggle
  // must flip per notch, where a 1%-of-sweep nudge would just round back.
  const discreteStep = desc.kind === "stepped" ? (desc.step ?? 1) : desc.kind === "continuous" ? null : 1;

  const nudge = (fraction: number): void => {
    if (discreteStep !== null) {
      if (fraction !== 0) {
        setLiveClamped(handle.live() + Math.sign(fraction) * discreteStep);
        handle.commit();
      }
      return;
    }
    const n = toNormalized(desc, handle.live());
    const next = Math.min(1, Math.max(0, n + fraction));
    setLiveClamped(fromNormalized(desc, next));
    handle.commit();
  };

  return {
    get dragging() {
      return drag !== null;
    },

    dragStart(y: number, fine: boolean): void {
      drag = {
        anchorNormalized: toNormalized(desc, handle.live()),
        anchorY: y,
        fine,
        startValue: handle.live(),
        active: true,
      };
    },

    dragMove(y: number, fine: boolean): void {
      if (drag === null) return;
      if (fine !== drag.fine) {
        // SS5: modifier change re-anchors so there is no value jump.
        drag.anchorNormalized = toNormalized(desc, handle.live());
        drag.anchorY = y;
        drag.fine = fine;
      }
      const sensitivity = (drag.fine ? FINE_FACTOR : 1) / DRAG_FULL_SWEEP_PX;
      const deltaN = (drag.anchorY - y) * sensitivity; // up = increase
      const n = Math.min(1, Math.max(0, drag.anchorNormalized + deltaN));
      setLiveClamped(fromNormalized(desc, n));
    },

    dragEnd(): void {
      if (drag === null) return;
      drag = null;
      handle.commit();
    },

    dragCancel(): void {
      if (drag === null) return;
      const restore = drag.startValue;
      drag = null;
      handle.setLive(restore, "user");
      // No commit: SS5 "`Esc` mid-drag reverts to the pre-drag value, no
      // undo entry" — live returns to base, the document never moved.
    },

    wheel(deltaNotches: number, fine: boolean): void {
      nudge(deltaNotches * WHEEL_STEP * (fine ? FINE_FACTOR : 1));
    },

    keyStep(sign: 1 | -1, options = {}): void {
      const step = options.page === true ? PAGE_STEP : KEY_STEP * (options.fine === true ? FINE_FACTOR : 1);
      nudge(sign * step);
    },

    reset(): void {
      setLiveClamped(desc.defaultValue);
      handle.commit();
    },

    setFromText(text: string): boolean {
      const parsed = desc.fromText(text);
      if (parsed === null || !Number.isFinite(parsed)) return false;
      setLiveClamped(parsed);
      handle.commit();
      return true;
    },
  };
}
