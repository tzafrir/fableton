// SS11: "marquee + the same keyboard nudges" — SS10's keyboard map, narrowed
// to what a lane has: move (both axes), fine-move, delete. Every key goes
// through the same commands the mouse uses (SS10: "the keyboard is a
// first-class client of the editor, not a bolt-on").

import type { Command, KeyBinding, Ticks } from "../../types";
import { FINE_NUDGE_TICKS } from "../../types/editor";
import type { AutomationLaneContext } from "./context";
import { LANE_PAD_PX, valueAtY, yOfValue } from "./layout";
import { clampMoveDeltaTicks, earliestTick } from "./points";

/** Value nudge as a fraction of the lane's height: one arrow press, and the
 *  `Shift` fine step. Pixels, so the taper applies exactly as it does to a
 *  drag of the same distance. */
const VALUE_NUDGE = 0.02;
const VALUE_NUDGE_FINE = 0.002;

export const AUTOMATION_KEY_BINDING_ID = "automation.keys";

export function createAutomationKeyBinding(ctx: AutomationLaneContext): KeyBinding {
  return {
    id: AUTOMATION_KEY_BINDING_ID,
    handle(input) {
      const laneId = ctx.laneId();
      const desc = ctx.desc();
      if (laneId === null || desc === null) return null;
      const selected = ctx.points().filter((p) => ctx.selection.has(p.t));
      if (input.key === "Delete" || input.key === "Backspace") {
        if (selected.length === 0) return { command: null };
        ctx.selection.clear();
        return { command: ctx.commands.deleteLanePoints(laneId, selected.map((p) => p.t)) };
      }
      if (selected.length === 0) return null;

      const heightPx = ctx.heightPx();
      const span = Math.max(1, heightPx - LANE_PAD_PX * 2);
      const nudge = (rawDeltaT: Ticks, deltaValuePx: number): Command | null => {
        // Same rule as the drag (points.ts): the DELTA is clamped once for the
        // whole selection, never per point, or an ArrowLeft at the left wall
        // would fold the selection onto tick 0 and lose every point but one.
        const deltaT = clampMoveDeltaTicks(rawDeltaT, earliestTick(selected));
        // Nothing left to give (the selection is already against the wall):
        // no command, so the wall cannot fill the undo stack with no-ops.
        if (deltaT === 0 && deltaValuePx === 0) return null;
        const edits = selected.map((p) => ({
          fromT: p.t,
          toT: p.t + deltaT,
          v:
            deltaValuePx === 0
              ? p.v
              : valueAtY(desc, yOfValue(desc, p.v, heightPx) - deltaValuePx, heightPx),
        }));
        ctx.selection.set(edits.map((e) => e.toT));
        return ctx.commands.moveLanePoints(laneId, edits);
      };

      const gridTicks = ctx.grid.gridTicks();
      const stepTicks = input.modifiers.shift ? FINE_NUDGE_TICKS : gridTicks;
      const stepValue = (input.modifiers.shift ? VALUE_NUDGE_FINE : VALUE_NUDGE) * span;
      switch (input.key) {
        case "ArrowLeft":
          return { command: nudge(-stepTicks, 0) };
        case "ArrowRight":
          return { command: nudge(stepTicks, 0) };
        case "ArrowUp":
          return { command: nudge(0, stepValue) };
        case "ArrowDown":
          return { command: nudge(0, -stepValue) };
        default:
          return null;
      }
    },
  };
}
