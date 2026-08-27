// Tempo-synced times, as note values (SS8: the document's time unit is the
// tick, and a device may only convert a note LENGTH — never a position).
//
// The list is the one a DAW's sync menu offers, ordered longest to shortest
// so a knob sweeping up gets faster. `beats` counts QUARTER notes, because
// that is what `DeviceTempo.secondsPerBeat()` measures: a whole note is 4, a
// dotted eighth 0.75, an eighth triplet 1/3. That makes the conversion one
// multiply and keeps the meaning identical in every time signature — a 1/8
// is an eighth note whether the bar has 4 beats or 7.

export interface NoteDivision {
  label: string;
  /** Length in quarter notes. */
  beats: number;
}

export const NOTE_DIVISIONS: readonly NoteDivision[] = [
  { label: "1/1", beats: 4 },
  { label: "1/2.", beats: 3 },
  { label: "1/2", beats: 2 },
  // A dotted quarter (1.5) really is longer than a half triplet (1.333) —
  // the straight/dotted/triplet families interleave, and the list is in
  // LENGTH order rather than family order so a knob sweeps monotonically.
  { label: "1/4.", beats: 1.5 },
  { label: "1/2T", beats: 4 / 3 },
  { label: "1/4", beats: 1 },
  { label: "1/8.", beats: 0.75 },
  { label: "1/4T", beats: 2 / 3 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16.", beats: 0.375 },
  { label: "1/8T", beats: 1 / 3 },
  { label: "1/16", beats: 0.25 },
  { label: "1/16T", beats: 1 / 6 },
  { label: "1/32", beats: 0.125 },
];

/** The division a device falls back to when a label is unknown. */
const FALLBACK_LABEL = "1/4";

/** The labels, for `p.enum` (SS4: an enum's value IS the index). */
export const NOTE_DIVISION_LABELS: readonly string[] = NOTE_DIVISIONS.map((d) => d.label);

/** Index of a division by label, for defaults that read as music. */
export function divisionIndex(label: string): number {
  const found = NOTE_DIVISIONS.findIndex((d) => d.label === label);
  if (found >= 0) return found;
  return Math.max(0, NOTE_DIVISIONS.findIndex((d) => d.label === FALLBACK_LABEL));
}

/** Length in quarter notes for an enum value; clamped, never NaN. */
export function divisionBeats(index: number): number {
  const i = Math.min(NOTE_DIVISIONS.length - 1, Math.max(0, Math.round(index)));
  return NOTE_DIVISIONS[i]?.beats ?? 1;
}

/** Seconds for an enum value at a given beat length. */
export function divisionSeconds(index: number, secondsPerBeat: number): number {
  const spb = Number.isFinite(secondsPerBeat) && secondsPerBeat > 0 ? secondsPerBeat : 0.5;
  return divisionBeats(index) * spb;
}

/** Hz for an enum value at a given beat length — one LFO cycle per division. */
export function divisionHz(index: number, secondsPerBeat: number): number {
  const seconds = divisionSeconds(index, secondsPerBeat);
  return seconds > 0 ? 1 / seconds : 1;
}
