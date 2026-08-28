// The design system's single source of truth (SS15 "App chrome").
//
// Two consumers, one palette. The DOM chrome reads these as CSS custom
// properties (./app.css mirrors every value below under `--fbl-*`); the
// canvas editors cannot read CSS variables from inside a `2d` context, so
// they import the same constants directly and hand them to their own theme
// objects (`ArrangementTheme`, `PianoRollTheme`, `AUTOMATION_THEME`). A
// colour therefore exists exactly once, and the arrangement's clip blue is
// provably the same blue as the mixer's.
//
// --- the plan this palette implements -------------------------------------
//
// Colour: "console at night". A blue-violet ink ground with surfaces that
// step up in luminance like stacked hardware panels, hairlines that read as
// machined seams, and only THREE signal hues, each with one job:
//   aqua  — live signal: note bodies, param arcs, enabled LEDs, meters
//   amber — attention:  selection, mute, an overridden automation lane, loop
//   coral — the transport: record, and the playhead
// Everything else is neutral, so the three hues never compete for meaning.
// Clips take their colour from the TRACK instead (`TRACK_COLORS`), which is
// what stops an arrangement of eight parts reading as one blue wall.
//
// Type: one family, system-first. Five sizes (9/10/11/12/13) with fixed
// roles, uppercase micro-labels at 0.08em tracking, and tabular numerals on
// every readout so digits stop dancing while the transport runs.

/** Ground and surfaces, darkest first. */
export const INK = {
  /** The app's ground; nothing sits behind it. */
  app: "#0b0d12",
  /** Panel ground — toolbar, tab bar, mixer, device chain. */
  panel: "#11141b",
  /** A raised element on a panel: a mixer strip, a device card. */
  raised: "#171b24",
  /** Raised again: a hovered row, a chain inside a rack. */
  raisedHigh: "#1e2431",
  /** Recessed: a text field, a meter trough, a fader rail. */
  well: "#080a0e",
  /** Hairline seam. */
  line: "#232936",
  /** A seam that needs to be seen — a card border, a focused field. */
  lineStrong: "#333b4c",
} as const;

export const TEXT = {
  /** Primary: names, values, anything read on purpose. */
  primary: "#e6eaf3",
  /** Secondary: labels, units, readouts. */
  dim: "#8d96aa",
  /** Tertiary: placeholders, disabled, "not bound yet". */
  faint: "#5a6375",
  /** On top of a filled accent. */
  onAccent: "#04161a",
} as const;

export const SIGNAL = {
  /** Live signal — the one colour a value is drawn in. */
  aqua: "#35d0c8",
  aquaDim: "#1f7d79",
  /** Attention — selection, mute, an overridden lane. */
  amber: "#f5b544",
  amberDim: "#8a6420",
  /** The transport — record, playhead. */
  coral: "#ff5d5d",
  /** Solo, loop, and the "this is routed" blue. Deliberately the same family
   *  as the default track colour, because both mean "signal path". */
  blue: "#5b8dee",
  /** A rejected edit's inline hint (SS6). */
  warn: "#f2915c",
  /** Meter greens; the peak end reuses `amber`/`coral`. */
  green: "#4fc98a",
} as const;

/**
 * The ribbon a new track's colour is taken from, in assignment order.
 *
 * Harmonised on purpose: all eight sit in the same lightness band, so no
 * lane shouts over its neighbours, and each is legible against `INK.app`
 * both as a 2 px header rule and as a filled clip body.
 */
export const TRACK_COLORS = [
  "#5b8dee", // blue
  "#35d0c8", // aqua
  "#f5b544", // amber
  "#e8735e", // coral
  "#a97bf0", // violet
  "#4fc98a", // green
  "#e871b8", // magenta
  "#4fb6d8", // sky
] as const;

/** The colour a channel at `index` gets when nothing else has claimed one. */
export function trackColorAt(index: number): string {
  return TRACK_COLORS[((index % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length]!;
}

export const FONT = {
  ui: '"Inter var", Inter, "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", "JetBrains Mono", "Roboto Mono", Menlo, monospace',
} as const;

/** Canvas `font` shorthands, so a ruler and a key label share one stack. */
export const CANVAS_FONT = {
  micro: `9px ${FONT.ui}`,
  small: `10px ${FONT.ui}`,
  label: `11px ${FONT.ui}`,
} as const;

/** `rgba()` from a `#rrggbb` and an alpha — the canvas themes need washes of
 *  the same hues the solid tokens define, and a second literal is a second
 *  thing to keep in sync. */
export function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(a)})`;
}
