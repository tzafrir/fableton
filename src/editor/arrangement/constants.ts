// SS9/SS10 — the arrangement skin's fixed numbers and its palette.
//
// Every pixel constant the KIT already fixes (`DRAG_THRESHOLD_PX`,
// `EDGE_ZONE_PX`, `EDGE_ZONE_FRACTION`, `MIN_CLIP_TICKS`,
// `FINE_NUDGE_TICKS`) is imported from the contract and re-exported here, so
// this package never re-declares a frozen number. What is genuinely local to
// this skin — lane chrome sizes and colours — lives below.

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
  playhead: string;
  headerBackground: string;
  headerText: string;
  headerBorder: string;
}

export const DEFAULT_THEME: ArrangementTheme = {
  background: "#16181c",
  laneEven: "#1c1f24",
  laneOdd: "#191c20",
  laneNonTrack: "#141619",
  laneBorder: "#0f1113",
  barLine: "#3a4048",
  beatLine: "#262b31",
  gridLine: "#1f2429",
  clipFill: "#4f7bd6",
  clipBorder: "#0d1013",
  clipText: "#f2f5fa",
  clipNote: "#0d1013",
  clipLoopBrace: "#f2c14e",
  clipRepeatLine: "#1a2029",
  selectionOutline: "#ffffff",
  hoverOutline: "#b9c7e2",
  ghostFill: "rgba(255,255,255,0.22)",
  ghostOutline: "#ffffff",
  marqueeFill: "rgba(120,160,255,0.16)",
  marqueeOutline: "#7ba0ff",
  rulerBackground: "#101216",
  rulerText: "#9aa5b1",
  rulerLine: "#333a42",
  playhead: "#ff5f56",
  headerBackground: "#15171b",
  headerText: "#d7dde5",
  headerBorder: "#0f1113",
};

export function resolveTheme(overrides?: Partial<ArrangementTheme> | undefined): ArrangementTheme {
  return overrides === undefined ? DEFAULT_THEME : { ...DEFAULT_THEME, ...overrides };
}
