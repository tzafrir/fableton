// Colors and metrics for the three piano-roll layers. One object, so the app
// shell can restyle the editor without touching a draw call, and so the layer
// tests can assert against named values instead of literals.

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
  background: "#16181d",
  rowWhite: "#1e2128",
  rowBlack: "#171a20",
  rowLine: "#101216",
  octaveLine: "#0a0b0e",
  gridLine: "#22262e",
  beatLine: "#2b3038",
  barLine: "#3a414d",
  outsideClip: "rgba(0, 0, 0, 0.28)",

  rulerBackground: "#101216",
  rulerText: "#8b94a3",
  rulerLine: "#2b3038",
  rulerFont: "10px ui-sans-serif, system-ui, sans-serif",

  noteFill: "#5aa9e6",
  noteMutedFill: "#3c4654",
  noteStroke: "#0d1014",
  noteSelectedFill: "#f2c14e",
  noteSelectedStroke: "#fff3d0",

  ghostFill: "rgba(242, 193, 78, 0.35)",
  ghostStroke: "rgba(255, 243, 208, 0.9)",
  marqueeFill: "rgba(90, 169, 230, 0.14)",
  marqueeStroke: "rgba(90, 169, 230, 0.8)",

  velocityBackground: "#12141a",
  velocityBorder: "#2b3038",
  velocityStalk: "#5aa9e6",
  velocityStalkSelected: "#f2c14e",
  velocitySweep: "rgba(242, 193, 78, 0.18)",

  // Reads as a piano keyboard turned on its side: the gutter is opaque so a
  // note scrolled to tick 0 cannot make the labels unreadable.
  keyGutterWhite: "#c8ccd4",
  keyGutterBlack: "#22252c",
  keyGutterLine: "#0a0b0e",
  keyGutterText: "#2a2d34",
  keyGutterTextBlack: "#9aa3b2",
  keyGutterFont: "9px ui-sans-serif, system-ui, sans-serif",
};
