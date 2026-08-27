// SS9 — "Coordinate discipline": the one shared transform per editor.
//
//   "Editor logic runs in musical units (ticks, pitch, param value) — pixels
//    exist only at the boundary. One shared `Viewport` object per editor
//    holds the transform."
//
// Everything here is pure arithmetic: no DOM, no canvas, no document. That is
// what makes the whole transform unit-testable headlessly (SS15).
//
// Invariants this implementation keeps, on top of the contract:
//   - `scrollTicks` is an INTEGER tick (SS8: fractional ticks are a bug), so
//     `xOf`/`tAt` round-trip without drift. `scrollRows` is fractional,
//     because a row is a layout unit, not a musical one.
//   - every mutator clamps to `limits` and fires `onChange` AT MOST ONCE, and
//     only when something actually moved.

import type { Unsub } from "../../types/common";
import type { Ticks } from "../../types/time";
import { TICKS_PER_WHOLE_NOTE } from "../../types/time";
import type {
  CreateViewport,
  Row,
  RowRange,
  TickRange,
  Viewport,
  ViewportLimits,
  ViewportOptions,
} from "../../types/viewport";

/**
 * Zoom/scroll clamps an editor gets before it calls `setLimits`. The tick and
 * row ceilings are placeholders that every editor replaces with its own
 * content extent ("`maxTick`/`maxRow` follow the content").
 */
export const DEFAULT_VIEWPORT_LIMITS: ViewportLimits = {
  // 0.0005 px/tick -> a 4/4 bar is ~1.9 px (a whole arrangement at a glance);
  // 2 px/tick -> a 1/16 note is 480 px (surgical note editing).
  minPxPerTick: 0.0005,
  maxPxPerTick: 2,
  minPxPerRow: 2,
  maxPxPerRow: 128,
  minTick: 0,
  maxTick: TICKS_PER_WHOLE_NOTE * 1024,
  minRow: 0,
  maxRow: 128,
};

/** A 4/4 bar is ~192 px, a 1/16 note ~12 px: the default editing zoom. */
export const DEFAULT_PX_PER_TICK = 0.05;
/** Piano-roll note-row height / arrangement lane height in CSS pixels. */
export const DEFAULT_PX_PER_ROW = 16;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}

/** Folds `-0` so scroll/tick equality and serialization never see a sign. */
function noNegZero(value: number): number {
  return value === 0 ? 0 : value;
}

export const createViewport: CreateViewport = (
  options: ViewportOptions = {},
): Viewport => {
  let limits: ViewportLimits = { ...DEFAULT_VIEWPORT_LIMITS, ...options.limits };

  let pxPerTick = clamp(
    options.pxPerTick ?? DEFAULT_PX_PER_TICK,
    limits.minPxPerTick,
    limits.maxPxPerTick,
  );
  let pxPerRow = clamp(
    options.pxPerRow ?? DEFAULT_PX_PER_ROW,
    limits.minPxPerRow,
    limits.maxPxPerRow,
  );
  let scrollTicks: Ticks = noNegZero(
    Math.round(clamp(options.scrollTicks ?? 0, limits.minTick, limits.maxTick)),
  );
  let scrollRows = noNegZero(
    clamp(options.scrollRows ?? 0, limits.minRow, limits.maxRow),
  );
  let widthPx = Math.max(0, options.widthPx ?? 0);
  let heightPx = Math.max(0, options.heightPx ?? 0);

  const listeners = new Set<(viewport: Viewport) => void>();

  /** Fractional tick under a pixel — internal precision for zoom anchoring. */
  const exactTickAt = (x: number): number => scrollTicks + x / pxPerTick;

  /**
   * Runs `fn`, then notifies once IF the transform actually changed. Every
   * public mutator goes through this, which is what makes them all
   * "idempotent-safe" and single-notification by construction.
   */
  const mutate = (fn: () => void): void => {
    const before = [pxPerTick, scrollTicks, pxPerRow, scrollRows, widthPx, heightPx];
    fn();
    const after = [pxPerTick, scrollTicks, pxPerRow, scrollRows, widthPx, heightPx];
    if (before.every((v, i) => v === after[i])) return;
    for (const cb of [...listeners]) cb(viewport);
  };

  const setScrollRaw = (ticks: number, rows: number): void => {
    scrollTicks = noNegZero(
      Math.round(clamp(ticks, limits.minTick, limits.maxTick)),
    );
    scrollRows = noNegZero(clamp(rows, limits.minRow, limits.maxRow));
  };

  const viewport: Viewport = {
    get pxPerTick() {
      return pxPerTick;
    },
    get scrollTicks() {
      return scrollTicks;
    },
    get pxPerRow() {
      return pxPerRow;
    },
    get scrollRows() {
      return scrollRows;
    },
    get widthPx() {
      return widthPx;
    },
    get heightPx() {
      return heightPx;
    },

    xOf(t: Ticks): number {
      return (t - scrollTicks) * pxPerTick;
    },
    tAt(x: number): Ticks {
      // SS8: `tAt` hands back an INTEGER tick. Drag math must go through
      // `tickDeltaOf` so the rounding happens once on the total delta.
      return noNegZero(Math.round(exactTickAt(x)));
    },
    yOf(row: Row): number {
      return (row - scrollRows) * pxPerRow;
    },
    rowAt(y: number): Row {
      return scrollRows + y / pxPerRow;
    },
    rowIndexOf(y: number): number {
      return Math.floor(scrollRows + y / pxPerRow);
    },

    tickDeltaOf(dxPx: number): Ticks {
      return noNegZero(Math.round(dxPx / pxPerTick));
    },
    rowDeltaOf(dyPx: number): number {
      return noNegZero(dyPx / pxPerRow);
    },

    zoomAt(px: number, factor: number): void {
      mutate(() => {
        if (!Number.isFinite(factor) || factor <= 0) return;
        const anchor = exactTickAt(px);
        const next = clamp(pxPerTick * factor, limits.minPxPerTick, limits.maxPxPerTick);
        if (next === pxPerTick) return;
        pxPerTick = next;
        // Keeps the time under the cursor fixed (SS9 "zoom-to-cursor").
        setScrollRaw(anchor - px / next, scrollRows);
      });
    },

    zoomRowsAt(py: number, factor: number): void {
      mutate(() => {
        if (!Number.isFinite(factor) || factor <= 0) return;
        const anchor = scrollRows + py / pxPerRow;
        const next = clamp(pxPerRow * factor, limits.minPxPerRow, limits.maxPxPerRow);
        if (next === pxPerRow) return;
        pxPerRow = next;
        setScrollRaw(scrollTicks, anchor - py / next);
      });
    },

    scrollBy(dxPx: number, dyPx: number): void {
      mutate(() => {
        setScrollRaw(scrollTicks + dxPx / pxPerTick, scrollRows + dyPx / pxPerRow);
      });
    },

    setScroll(ticks: Ticks, rows: number): void {
      mutate(() => {
        setScrollRaw(ticks, rows);
      });
    },

    setSize(nextWidthPx: number, nextHeightPx: number): void {
      mutate(() => {
        widthPx = Math.max(0, nextWidthPx);
        heightPx = Math.max(0, nextHeightPx);
      });
    },

    setLimits(next: Partial<ViewportLimits>): void {
      mutate(() => {
        limits = { ...limits, ...next };
        pxPerTick = clamp(pxPerTick, limits.minPxPerTick, limits.maxPxPerTick);
        pxPerRow = clamp(pxPerRow, limits.minPxPerRow, limits.maxPxPerRow);
        setScrollRaw(scrollTicks, scrollRows);
      });
    },

    revealTick(t: Ticks, marginPx = 0): void {
      mutate(() => {
        const x = (t - scrollTicks) * pxPerTick;
        if (x < marginPx) {
          setScrollRaw(t - marginPx / pxPerTick, scrollRows);
        } else if (x > widthPx - marginPx) {
          setScrollRaw(t - (widthPx - marginPx) / pxPerTick, scrollRows);
        }
      });
    },

    revealRow(row: Row, marginPx = 0): void {
      mutate(() => {
        // A row occupies `[row, row + 1)`; reveal the whole cell.
        const top = (row - scrollRows) * pxPerRow;
        const bottom = top + pxPerRow;
        if (top < marginPx) {
          setScrollRaw(scrollTicks, row - marginPx / pxPerRow);
        } else if (bottom > heightPx - marginPx) {
          setScrollRaw(scrollTicks, row + 1 - (heightPx - marginPx) / pxPerRow);
        }
      });
    },

    visibleTicks(): TickRange {
      // Integer bounds that fully cover the fractional window. Culling matches
      // items that OVERLAP this range, so no left-hand padding is needed.
      return {
        start: noNegZero(Math.floor(exactTickAt(0))),
        end: noNegZero(Math.ceil(exactTickAt(widthPx))),
      };
    },

    visibleRows(): RowRange {
      // Padded by one row each side: content may draw taller than its row
      // (piano-roll ghosts, arrangement clip borders).
      return {
        start: scrollRows - 1,
        end: scrollRows + heightPx / pxPerRow + 1,
      };
    },

    onChange(cb: (v: Viewport) => void): Unsub {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  return viewport;
};
