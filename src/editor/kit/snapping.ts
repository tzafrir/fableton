// SS10's `Alt` bypass, written once. Editors call these instead of touching
// `Grid` directly, so "Alt while dragging bypasses snap entirely" cannot be
// forgotten in one handler and remembered in another.

import type { Modifiers } from "../../types/gesture";
import type { Ticks } from "../../types/time";
import type { Grid, SnapMode } from "../../types/viewport";

/** True when the live modifiers say "no snapping for this frame". */
export function snapBypassed(modifiers: Modifiers): boolean {
  return modifiers.alt;
}

/**
 * Relative snap for every move/resize drag and every arrow nudge: the DELTA is
 * rounded, so items keep their off-grid offsets (SS10 "Moves are relative").
 */
export function snapMoveDelta(
  grid: Grid,
  deltaTicks: Ticks,
  modifiers: Modifiers,
  mode: SnapMode = "nearest",
): Ticks {
  if (snapBypassed(modifiers)) return deltaTicks;
  return grid.snapDelta(deltaTicks, mode);
}

/**
 * Absolute snap, used ONLY when creating (note/clip creation, playhead
 * placement) — SS10: "absolute snap applies only when creating".
 */
export function snapCreateTick(
  grid: Grid,
  tick: Ticks,
  modifiers: Modifiers,
  mode: SnapMode = "floor",
): Ticks {
  if (snapBypassed(modifiers)) return tick;
  return grid.snap(tick, mode);
}
