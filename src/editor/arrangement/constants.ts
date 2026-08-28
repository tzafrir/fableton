// SS9/SS10 — the arrangement skin's fixed numbers and its palette.
//
// Every pixel constant the KIT already fixes (`DRAG_THRESHOLD_PX`,
// `EDGE_ZONE_PX`, `EDGE_ZONE_FRACTION`, `MIN_CLIP_TICKS`,
// `FINE_NUDGE_TICKS`) is imported from the contract and re-exported here, so
// this package never re-declares a frozen number. What is genuinely local to
// this skin — lane chrome sizes and colours — lives below.

import { INK, SIGNAL, TEXT, TRACK_COLORS, alpha } from "../../ui/theme";

export {
  EDGE_ZONE_FRACTION,
  EDGE_ZONE_PX,
  FINE_NUDGE_TICKS,
  MIN_CLIP_TICKS,
} from "../../types/editor";

/** Height of the time ruler strip, in CSS pixels. */
export const RULER_HEIGHT_PX = 26;

/** Width of the lane-header column, in CSS pixels. */
export const HEADER_WIDTH_PX = 132;

/** Default lane height. Rows are the viewport's vertical unit (SS9). */
export const DEFAULT_LANE_HEIGHT_PX = 56;

/** Vertical inset of a clip rectangle inside its lane, per side. */
export const CLIP_INSET_PX = 2;

/** Height of the loop brace band along the top of a looped clip. Capped at a
 *  fraction of the lane height so a squashed lane keeps a grabbable body. */
export const LOOP_BRACE_PX = 8;
export const LOOP_BRACE_FRACTION = 0.28;

/** Height of the transport loop band along the TOP of the ruler. Below it,
 *  the ruler still seeks — so the two gestures never fight for a pixel. */
export const LOOP_BAND_HEIGHT_PX = 10;

/** Grab tolerance for either end of the transport loop brace, in CSS px. */
export const LOOP_EDGE_GRAB_PX = 5;

/** Pointer travel below which a loop-band press is a CLICK (toggle), not a
 *  drag (define a region) — the same "did it move?" threshold the kit uses
 *  to separate a click from a drag. */
export const LOOP_DRAG_THRESHOLD_PX = 3;

/** Grab tolerance for a loop brace handle, per side, in CSS pixels. */
export const LOOP_HANDLE_PX = 5;

/** Below this lane height the loop brace stops being a hit target (it is
 *  still drawn as a hairline) — the body must stay grabbable. */
export const MIN_BRACE_LANE_PX = 18;

/** Padding kept to the right of the last clip so there is always somewhere
 *  to scroll to and somewhere to drop a new clip. */
export const CONTENT_TAIL_BARS = 8;

// --- palette ---------------------------------------------------------------

/** Colours the layers draw with. The app shell may override any of them. */
export interface ArrangementTheme {
  background: string;
  laneEven: string;
  laneOdd: string;
  laneNonTrack: string;
  laneBorder: string;
  barLine: string;
  beatLine: string;
  gridLine: string;
  clipFill: string;
  clipBorder: string;
  clipText: string;
  clipNote: string;
  clipLoopBrace: string;
  clipRepeatLine: string;
  selectionOutline: string;
  hoverOutline: string;
  ghostFill: string;
  ghostOutline: string;
  marqueeFill: string;
  marqueeOutline: string;
  rulerBackground: string;
  rulerText: string;
  rulerLine: string;
  /** Transport loop brace, drawn in the ruler's top band. */
  loopBrace: string;
  loopBraceOff: string;
  loopHandle: string;
  playhead: string;
  headerBackground: string;
  headerText: string;
  headerBorder: string;
}

export const DEFAULT_THEME: ArrangementTheme = {
  background: INK.app,
  // Lanes alternate by a hair — enough to track a row across a wide
  // arrangement, not enough to read as stripes.
  laneEven: "#12151d",
  laneOdd: "#0f1219",
  laneNonTrack: "#0c0f15",
  laneBorder: "#0a0c11",
  barLine: "#394152",
  beatLine: "#232936",
  gridLine: "#171c26",
  // The DEFAULT clip colour only shows on a channel with no colour of its
  // own; new tracks take a hue from `TRACK_COLORS`, so a full arrangement
  // reads as parts rather than as one blue wall.
  clipFill: TRACK_COLORS[0],
  clipBorder: "#080a0e",
  clipText: "#f4f7ff",
  clipNote: "#0a0d13",
  clipLoopBrace: SIGNAL.amber,
  clipRepeatLine: alpha("#000000", 0.34),
  selectionOutline: "#ffffff",
  hoverOutline: "#c3cee6",
  ghostFill: alpha("#ffffff", 0.22),
  ghostOutline: "#ffffff",
  marqueeFill: alpha(SIGNAL.aqua, 0.14),
  marqueeOutline: SIGNAL.aqua,
  rulerBackground: "#0d1017",
  rulerText: TEXT.dim,
  rulerLine: "#2b3244",
  // Bright when the transport will actually loop, greyed when the brace is
  // set but switched off — the same region either way, so dragging it never
  // has to mean "and also turn looping on".
  loopBrace: SIGNAL.blue,
  loopBraceOff: "#333b4c",
  loopHandle: "#d5e4ff",
  playhead: SIGNAL.coral,
  headerBackground: INK.panel,
  headerText: TEXT.primary,
  headerBorder: "#1b2028",
};

export function resolveTheme(overrides?: Partial<ArrangementTheme> | undefined): ArrangementTheme {
  return overrides === undefined ? DEFAULT_THEME : { ...DEFAULT_THEME, ...overrides };
}
