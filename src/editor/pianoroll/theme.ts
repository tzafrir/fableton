// Colors and metrics for the three piano-roll layers. One object, so the app
// shell can restyle the editor without touching a draw call, and so the layer
// tests can assert against named values instead of literals.

import { CANVAS_FONT, SIGNAL, TEXT, alpha } from "../../ui/theme";

export interface PianoRollTheme {
  background: string;
  rowWhite: string;
  rowBlack: string;
  rowLine: string;
  octaveLine: string;
  gridLine: string;
  beatLine: string;
  barLine: string;
  /** Everything past the clip's length is dimmed by this overlay. */
  outsideClip: string;

  rulerBackground: string;
  rulerText: string;
  rulerLine: string;
  rulerFont: string;

  noteFill: string;
  noteMutedFill: string;
  noteStroke: string;
  noteSelectedFill: string;
  noteSelectedStroke: string;

  ghostFill: string;
  ghostStroke: string;
  marqueeFill: string;
  marqueeStroke: string;

  velocityBackground: string;
  velocityBorder: string;
  velocityStalk: string;
  velocityStalkSelected: string;
  velocitySweep: string;

  /** Key-name gutter down the left of the note grid. */
  keyGutterWhite: string;
  keyGutterBlack: string;
  keyGutterLine: string;
  keyGutterText: string;
  keyGutterTextBlack: string;
  keyGutterFont: string;
}

export const DEFAULT_PIANO_ROLL_THEME: PianoRollTheme = {
  background: "#0d1017",
  // White and black key rows differ by luminance only — the grid must never
  // out-shout the notes drawn on top of it.
  rowWhite: "#161a23",
  rowBlack: "#0f131a",
  rowLine: "#0a0d12",
  octaveLine: "#050709",
  gridLine: "#1b202b",
  beatLine: "#252c3a",
  barLine: "#39415380",
  outsideClip: alpha("#05070b", 0.42),

  rulerBackground: "#0d1017",
  rulerText: TEXT.dim,
  rulerLine: "#2b3244",
  rulerFont: CANVAS_FONT.small,

  // A note is live signal, so it is aqua; a SELECTED note is attention, so
  // it is amber. Two hues, one rule, and it holds in the velocity lane too.
  noteFill: SIGNAL.aqua,
  noteMutedFill: "#39424f",
  noteStroke: "#06090d",
  noteSelectedFill: SIGNAL.amber,
  noteSelectedStroke: "#fff0cd",

  ghostFill: alpha(SIGNAL.amber, 0.35),
  ghostStroke: alpha("#fff3d0", 0.9),
  marqueeFill: alpha(SIGNAL.aqua, 0.14),
  marqueeStroke: alpha(SIGNAL.aqua, 0.8),

  velocityBackground: "#0a0d13",
  velocityBorder: "#252c3a",
  velocityStalk: SIGNAL.aqua,
  velocityStalkSelected: SIGNAL.amber,
  velocitySweep: alpha(SIGNAL.amber, 0.18),

  // Reads as a piano keyboard turned on its side: the gutter is opaque so a
  // note scrolled to tick 0 cannot make the labels unreadable.
  keyGutterWhite: "#c9ceda",
  keyGutterBlack: "#191d26",
  keyGutterLine: "#070910",
  keyGutterText: "#262b35",
  keyGutterTextBlack: "#9aa3b4",
  keyGutterFont: CANVAS_FONT.micro,
};
