// SS9 — Coordinate discipline for the canvas editor kit.
//
// "Editor logic runs in musical units (ticks, pitch, param value) — pixels
// exist only at the boundary. One shared `Viewport` object per editor holds
// the transform." Every editor (arrangement lanes, piano roll, and M3's
// automation lanes) instantiates ONE of these and never computes a pixel
// anywhere else.
//
// Implemented by `canvas-kit` in src/editor/kit/.

import type { Unsub } from "./common";
import type { Ticks } from "./time";

/** Half-open tick window, `start` inclusive / `end` exclusive. */
export interface TickRange {
  start: Ticks;
  end: Ticks;
}

/** Row window in the vertical (pitch / track / value) axis. Fractional. */
export interface RowRange {
  start: number;
  end: number;
}

/**
 * ROW CONVENTION, frozen for every editor: rows are a continuous coordinate
 * that increases DOWNWARD from the top of the content, row `n` occupies
 * `[n, n+1)`, and row 0 is the topmost item.
 *
 *   piano roll  : `row = 127 - pitch`   (pitch 127 on top)
 *   arrangement : `row = index in Project.channelOrder`
 *   automation  : one row per lane; the value axis lives inside the row
 *
 * The kit never learns what a row means; each editor owns that one-line map.
 */
export type Row = number;

/** Rounding for grid snapping. Same literals as `SnapMode` in src/time/grid.ts
 *  (this module must not import from a runtime package). */
export type SnapMode = "nearest" | "floor" | "ceil";

export interface ViewportLimits {
  minPxPerTick: number;
  maxPxPerTick: number;
  minPxPerRow: number;
  maxPxPerRow: number;
  /** Scroll clamps in content units. `maxTick`/`maxRow` follow the content. */
  minTick: Ticks;
  maxTick: Ticks;
  minRow: number;
  maxRow: number;
}

export interface ViewportOptions {
  pxPerTick?: number | undefined;
  scrollTicks?: Ticks | undefined;
  pxPerRow?: number | undefined;
  scrollRows?: number | undefined;
  widthPx?: number | undefined;
  heightPx?: number | undefined;
  limits?: Partial<ViewportLimits> | undefined;
}

/**
 * SS9, verbatim in the members it names, plus the minimum any implementation
 * of those members needs to exist at all (size, scroll, culling, change
 * notification).
 *
 * Contract details that matter across packages:
 * - `xOf`/`yOf` return CSS pixels relative to the editor's content origin
 *   (top-left of the canvas), NOT device pixels. The renderer applies
 *   `devicePixelRatio` (SS9); nothing else ever multiplies by it.
 * - `tAt` returns an INTEGER tick (SS8: fractional ticks are a bug). Use
 *   `tickDeltaOf` for drag arithmetic so rounding happens once, on the total
 *   delta, instead of accumulating per frame.
 * - `rowAt` returns a FRACTIONAL row (0.5 = halfway down row 0);
 *   `rowIndexOf` is the floored integer row.
 * - `zoomAt` keeps the tick under `px` fixed (SS9 "zoom-to-cursor").
 * - Mutators are idempotent-safe and clamp to `limits`; each fires
 *   `onChange` at most once per call and only when something actually moved.
 */
export interface Viewport {
  readonly pxPerTick: number;
  readonly scrollTicks: Ticks;
  readonly pxPerRow: number;
  readonly scrollRows: number;
  /** Content size of the editor in CSS pixels. */
  readonly widthPx: number;
  readonly heightPx: number;

  xOf(t: Ticks): number;
  tAt(x: number): Ticks;
  yOf(row: Row): number;
  rowAt(y: number): Row;
  rowIndexOf(y: number): number;

  /** Pixel deltas -> content deltas, rounded once (see note above). */
  tickDeltaOf(dxPx: number): Ticks;
  rowDeltaOf(dyPx: number): number;

  zoomAt(px: number, factor: number): void;
  /** Vertical counterpart; `py` is the y that must stay put. */
  zoomRowsAt(py: number, factor: number): void;
  scrollBy(dxPx: number, dyPx: number): void;
  setScroll(ticks: Ticks, rows: number): void;
  setSize(widthPx: number, heightPx: number): void;
  setLimits(limits: Partial<ViewportLimits>): void;
  /** Scrolls the minimum distance that brings a tick/row into view. */
  revealTick(t: Ticks, marginPx?: number): void;
  revealRow(row: Row, marginPx?: number): void;

  /** Culling windows, already padded by one item where the kit needs it. */
  visibleTicks(): TickRange;
  visibleRows(): RowRange;

  onChange(cb: (viewport: Viewport) => void): Unsub;
}

export type CreateViewport = (options?: ViewportOptions) => Viewport;

// --- grid & snapping (SS10 "Snapping") --------------------------------------

/**
 * SS10: "Grid is adaptive to zoom (as in Live) with a fixed-grid override menu
 * and a triplet toggle." Ephemeral UI state — never in the document.
 */
export interface GridSettings {
  /** `'adaptive'` derives the division from `pxPerTick`; `'fixed'` uses
   *  `denominator`; `'off'` disables snapping entirely. */
  mode: "adaptive" | "fixed" | "off";
  /** Note value for `'fixed'` (4 = 1/4, 16 = 1/16). Ignored otherwise. */
  denominator: number;
  triplet: boolean;
}

/**
 * The snapping service the gesture engine hands to drag handlers. One
 * implementation in the kit, so "moves are relative, creation is absolute,
 * `Alt` bypasses, resize snaps only the moving edge" (SS10) is written once.
 */
export interface Grid {
  readonly settings: GridSettings;
  setSettings(settings: Partial<GridSettings>): void;
  /** Current division in ticks, given the viewport's zoom. */
  gridTicks(): Ticks;
  /** Absolute snap — note creation, clip creation, playhead placement. */
  snap(tick: Ticks, mode?: SnapMode): Ticks;
  /** Relative snap — every move/resize drag and every arrow-key nudge.
   *  Rounds the DELTA, preserving each item's off-grid offset (SS10). */
  snapDelta(deltaTicks: Ticks, mode?: SnapMode): Ticks;
  onChange(cb: (grid: Grid) => void): Unsub;
}
