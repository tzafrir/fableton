// Readout formatting + entry parsing shared by every descriptor factory.
//
// SS4: `toText` must be total over [min, max]; `fromText` returns `null` when
// the entry is unparseable. SS5's double-click numeric entry accepts loose
// input ("1.2k", "-6db", "50%"), which is what `parseNumeric` implements.

/** Multiplier table: normalized suffix -> factor applied to the number. */
export type SuffixTable = Readonly<Record<string, number>>;

const NUMBER_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/;

/**
 * Parses `"1.2 kHz"`, `"-6db"`, `"50 %"`, `"+3 st"` into a real-unit number.
 * Returns `null` for an empty entry, a non-numeric entry, or a suffix that is
 * not in `suffixes` (an unrecognised unit is a typo, not a silent 1x).
 */
export function parseNumeric(input: string, suffixes: SuffixTable): number | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = NUMBER_RE.exec(trimmed);
  if (match === null) return null;
  const value = Number.parseFloat(match[0]);
  if (!Number.isFinite(value)) return null;
  const suffix = trimmed.slice(match[0].length).trim().toLowerCase();
  const factor = Object.prototype.hasOwnProperty.call(suffixes, suffix)
    ? suffixes[suffix]
    : undefined;
  if (factor === undefined) return null;
  return value * factor;
}

/** Drops trailing zeros: 3.500 -> "3.5", 4 -> "4". */
export function trimNumber(v: number, maxDecimals = 3): string {
  if (!Number.isFinite(v)) return "0";
  const fixed = v.toFixed(maxDecimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

export const HZ_SUFFIXES: SuffixTable = { "": 1, hz: 1, k: 1000, khz: 1000, kh: 1000 };
export const DB_SUFFIXES: SuffixTable = { "": 1, db: 1, dbfs: 1 };
export const MS_SUFFIXES: SuffixTable = { "": 1, ms: 1, msec: 1, s: 1000, sec: 1000, secs: 1000 };
export const PERCENT_SUFFIXES: SuffixTable = { "": 1, "%": 1, pct: 1, percent: 1 };
export const SEMITONE_SUFFIXES: SuffixTable = { "": 1, st: 1, semi: 1, semitone: 1, semitones: 1 };

export function formatHz(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(2)} kHz`;
  if (abs >= 100) return `${v.toFixed(0)} Hz`;
  if (abs >= 10) return `${v.toFixed(1)} Hz`;
  return `${v.toFixed(2)} Hz`;
}

/**
 * A dB range whose bottom is at or below this reads as `-inf dB` (fader-sized
 * range), and anything above it reads as a number.
 *
 * One definition, because the readout is a CONTRACT, not just formatting: SS4
 * makes `toText` the sanctioned readout of the real value, so a param whose
 * bottom says "-inf dB" must actually be silent in the DSP. Every consumer of
 * that rule goes through `dbSilenceFloor` — the descriptor's `toText`
 * (./descriptors.ts), the harness's gain-node fast path (`gainForValue` in
 * src/devices/harness/deviceInstance.ts) and, across the postMessage boundary
 * where an import is impossible, `GAIN_SILENCE_DB` in
 * src/worklets/poly-synth-processor.ts.
 */
export const DB_SILENCE_FLOOR = -60;

/** The dB value at which a descriptor with this `min` means silence, or
 *  `undefined` when its range is too narrow to have a silent end. */
export function dbSilenceFloor(min: number): number | undefined {
  return min <= DB_SILENCE_FLOOR ? min : undefined;
}

export function formatDb(v: number, silenceBelow?: number): string {
  if (silenceBelow !== undefined && v <= silenceBelow) return "-inf dB";
  return `${v.toFixed(1)} dB`;
}

export function formatMs(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (abs >= 100) return `${v.toFixed(0)} ms`;
  if (abs >= 10) return `${v.toFixed(1)} ms`;
  return `${v.toFixed(2)} ms`;
}

export function formatPercent(v: number): string {
  return Math.abs(v) >= 10 ? `${v.toFixed(0)} %` : `${trimNumber(v, 1)} %`;
}

export function formatSemitones(v: number): string {
  const body = Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2);
  return `${v > 0 ? "+" : ""}${body} st`;
}

/** Ableton-style pan readout over a bipolar -1..1 param. */
export function formatPan(v: number): string {
  const pct = Math.round(Math.abs(v) * 100);
  if (pct === 0) return "C";
  return v < 0 ? `${pct}L` : `${pct}R`;
}

/** Parses "50L" / "C" / "25R" (and plain numbers) into -1..1. */
export function parsePan(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (trimmed === "c" || trimmed === "center" || trimmed === "centre") return 0;
  const sided = /^([-+]?[\d.]+)\s*(l|r)$/.exec(trimmed);
  if (sided !== null) {
    const magnitude = Number.parseFloat(sided[1] ?? "");
    if (!Number.isFinite(magnitude)) return null;
    const scaled = Math.abs(magnitude) > 1 ? magnitude / 100 : magnitude;
    return sided[2] === "l" ? -scaled : scaled;
  }
  const plain = parseNumeric(trimmed, { "": 1, "%": 0.01 });
  if (plain === null) return null;
  return Math.abs(plain) > 1 ? plain / 100 : plain;
}
