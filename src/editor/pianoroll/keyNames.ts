// Pitch -> name, and the key-name gutter's metrics.
//
// Octave numbering follows the convention this app's namesake uses: MIDI 60
// is C3, so the visible range runs C-2 (0) to G8 (127). Scientific pitch
// notation would put middle C at C4 — one octave up from every label a user
// of that other DAW expects — so the offset is a deliberate choice, not an
// off-by-one.

/** Sharp spellings; a key signature would be needed to choose flats. */
export const PITCH_CLASS_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

/** MIDI 60 is C3 here (see the file header). */
export const MIDDLE_C_OCTAVE = 3;

/** `"C3"`, `"F#-1"`. Total: any integer pitch gets a name. */
export function noteName(pitch: number): string {
  const p = Math.round(pitch);
  const pc = ((p % 12) + 12) % 12;
  const octave = Math.floor(p / 12) - (5 - MIDDLE_C_OCTAVE);
  return `${PITCH_CLASS_NAMES[pc] ?? "?"}${octave}`;
}

/** True for the black keys of a piano octave. */
export function isBlackKeyPitch(pitch: number): boolean {
  const pc = ((Math.round(pitch) % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

/** Width of the key-name gutter drawn down the left of the note grid. */
export const KEY_GUTTER_WIDTH_PX = 34;

/** ...and its width when the rows carry DEVICE names instead of pitches
 *  ("Open Hat" needs more room than "F#3"). The roll swaps between the two
 *  as the open clip's instrument changes; see `PianoRollView.setPitchNames`. */
export const NAMED_GUTTER_WIDTH_PX = 78;

/** Below this row height a per-row label cannot be read, so only the C of
 *  each octave is labelled — enough to keep your bearings when zoomed out. */
export const KEY_LABEL_MIN_ROW_PX = 9;
