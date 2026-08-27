// SS18-M0's hard-coded clip: "a hard-coded MidiClip ... played through a
// hard-coded chain" — a short, recognisable phrase so the M0 audible proof
// is actually checkable by ear, not just by a non-zero sample somewhere.
//
// A one-bar C major arpeggio at 120 bpm, up then down: C4 E4 G4 C5 B4 G4 E4
// C4, eighth notes. All ticks are integers at PPQ=960 (SS8) — `EIGHTH` is
// exactly `PPQ / 2` = 480, never a magic number.

import type { MidiClip, Note } from "../types";
import { PPQ } from "../types";

/** The channel this clip's notes target; the demo mounts its synth here. */
export const DEMO_TRACK_ID = "demo-track";

/** Fixed tempo for the whole demo (SS8: v1 ships a single fixed segment). */
export const DEMO_BPM = 120;

const EIGHTH = PPQ / 2; // 480 ticks
/** Notes stop short of the next one so repeated pitches are audibly separate. */
const NOTE_DUR = EIGHTH - 40;
const VELOCITY = 100;

/** C4, E4, G4, C5, B4, G4, E4, C4 — MIDI pitch numbers. */
const PHRASE_PITCHES = [60, 64, 67, 72, 71, 67, 64, 60] as const;

const notes: Note[] = PHRASE_PITCHES.map((pitch, i) => ({
  id: `demo-note-${i}`,
  start: i * EIGHTH,
  dur: NOTE_DUR,
  pitch,
  vel: VELOCITY,
}));

export const DEMO_CLIP: MidiClip = {
  id: "demo-clip",
  trackId: DEMO_TRACK_ID,
  start: 0,
  length: PHRASE_PITCHES.length * EIGHTH,
  notes,
};
