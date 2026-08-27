// SS10 "Snapping" — one implementation of the whole snapping policy, so the
// rules live in exactly one tested place:
//
//   "Grid is adaptive to zoom (as in Live) with a fixed-grid override menu and
//    a triplet toggle. Moves are RELATIVE: dragging or arrow-moving shifts
//    notes in grid increments from their original position, preserving
//    off-grid offsets; absolute snap applies only when creating. `Alt` while
//    dragging bypasses snap entirely. Resize snaps the moving edge, never the
//    anchored one."
//
// `snapDelta` is the relative half, `snap` the absolute half; `Alt` bypass is
// in ./snapping.ts so both the kit and the editors spell it the same way.
// Grid settings are EPHEMERAL UI state (SS13) — never in the document.

import type { Unsub } from "../../types/common";
import type { Ticks } from "../../types/time";
import { TICKS_PER_WHOLE_NOTE } from "../../types/time";
import type { Grid, GridSettings, SnapMode, Viewport } from "../../types/viewport";
import { snapTicks, ticksPerNote } from "../../time";

/**
 * The adaptive ladder, finest first, in ticks at 960 PPQ. Note values down to
 * a 1/128 (30 ticks, the SS10 resize floor) and up through multi-bar steps so
 * a fully zoomed-out arrangement still gets a usable grid.
 */
const STRAIGHT_DIVISIONS: readonly Ticks[] = [
  ticksPerNote(128), // 30
  ticksPerNote(64), //  60
  ticksPerNote(32), // 120
  ticksPerNote(16), // 240
  ticksPerNote(8), //  480
  ticksPerNote(4), //  960   (1 beat in 4/4)
  ticksPerNote(2), // 1920
  ticksPerNote(1), // 3840   (1 bar in 4/4)
  TICKS_PER_WHOLE_NOTE * 2,
  TICKS_PER_WHOLE_NOTE * 4,
  TICKS_PER_WHOLE_NOTE * 8,
  TICKS_PER_WHOLE_NOTE * 16,
  TICKS_PER_WHOLE_NOTE * 32,
];

/** Triplet subdivision of the same ladder (2/3 of the straight duration). */
const TRIPLET_DIVISIONS: readonly Ticks[] = STRAIGHT_DIVISIONS.map(
  (t) => (t * 2) / 3,
);

/**
 * Adaptive mode picks the FINEST division whose cell is at least this wide on
 * screen. Below it the grid stops being a usable target and starts being
 * moiré, which is exactly the "as in Live" behaviour SS10 asks for.
 */
export const ADAPTIVE_MIN_GRID_PX = 12;

export const DEFAULT_GRID_SETTINGS: GridSettings = {
  mode: "adaptive",
  denominator: 16,
  triplet: false,
};

function adaptiveTicks(pxPerTick: number, triplet: boolean): Ticks {
  const ladder = triplet ? TRIPLET_DIVISIONS : STRAIGHT_DIVISIONS;
  const coarsest = ladder[ladder.length - 1] ?? TICKS_PER_WHOLE_NOTE;
  if (!(pxPerTick > 0)) return coarsest;
  for (const ticks of ladder) {
    if (ticks * pxPerTick >= ADAPTIVE_MIN_GRID_PX) return ticks;
  }
  return coarsest;
}

export interface GridOptions {
  viewport: Viewport;
  settings?: Partial<GridSettings> | undefined;
}

/**
 * The grid is a projection of (settings, viewport zoom) — it holds no state of
 * its own beyond the settings, and it re-notifies when an adaptive division
 * changes under a zoom, so an editor can invalidate its grid layer.
 */
export function createGrid(options: GridOptions): Grid {
  const { viewport } = options;
  let settings: GridSettings = { ...DEFAULT_GRID_SETTINGS, ...options.settings };
  const listeners = new Set<(grid: Grid) => void>();

  const compute = (): Ticks => {
    if (settings.mode === "fixed") {
      return ticksPerNote(settings.denominator, settings.triplet);
    }
    // `'off'` still reports a division: SS10's "create grid-length note" and
    // the ruler both need one even when snapping is disabled.
    return adaptiveTicks(viewport.pxPerTick, settings.triplet);
  };

  let lastTicks = compute();

  const notify = (): void => {
    for (const cb of [...listeners]) cb(grid);
  };

  // An adaptive grid changes with zoom, so the viewport is an input.
  viewport.onChange(() => {
    const next = compute();
    if (next === lastTicks) return;
    lastTicks = next;
    notify();
  });

  const grid: Grid = {
    get settings() {
      return settings;
    },

    setSettings(next: Partial<GridSettings>): void {
      const merged: GridSettings = { ...settings, ...next };
      if (
        merged.mode === settings.mode &&
        merged.denominator === settings.denominator &&
        merged.triplet === settings.triplet
      ) {
        return;
      }
      settings = merged;
      lastTicks = compute();
      notify();
    },

    gridTicks(): Ticks {
      lastTicks = compute();
      return lastTicks;
    },

    snap(tick: Ticks, mode: SnapMode = "nearest"): Ticks {
      if (settings.mode === "off") return tick;
      return snapTicks(tick, grid.gridTicks(), mode);
    },

    snapDelta(deltaTicks: Ticks, mode: SnapMode = "nearest"): Ticks {
      // SS10: rounding the DELTA is what preserves each item's off-grid
      // offset. Never snap the resulting absolute position for a move.
      if (settings.mode === "off") return deltaTicks;
      return snapTicks(deltaTicks, grid.gridTicks(), mode);
    },

    onChange(cb: (g: Grid) => void): Unsub {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  return grid;
}
