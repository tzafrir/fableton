// SS10 — MIDI data model (the minimum M0 needs for its hard-coded clip).
//
// MIDI data is instrument-agnostic by construction (SS7 swap semantics):
// nothing in here references a device, only the channel that hosts it.

import type { ChannelId, ClipId, NoteId } from "./ids";
import type { Ticks } from "./time";

/** SS10, verbatim. `start`/`dur` are integer ticks; `dur` >= 1. */
export interface Note {
  id: NoteId;
  start: Ticks;
  dur: Ticks;
  /** MIDI pitch, 0-127. */
  pitch: number;
  /** MIDI velocity, 1-127. */
  vel: number;
  muted?: boolean | undefined;
}

/**
 * SS10, verbatim. `start` is the clip's position on the timeline; note
 * `start`s are relative to the clip's own origin (tick 0 = clip start), so
 * moving a clip never rewrites its notes.
 *
 * `loop`, when present, is the region (in clip-relative ticks) the player
 * unrolls repeatedly to fill `length`.
 */
export interface MidiClip {
  id: ClipId;
  trackId: ChannelId;
  start: Ticks;
  length: Ticks;
  loop?: { start: Ticks; end: Ticks } | undefined;
  notes: Note[];
  /**
   * Arrangement-visible label. Optional so every M0 literal stays valid;
   * absent means "show the track name" (M1 addition, SS18-M1).
   */
  name?: string | undefined;
  /** CSS color override for the clip rectangle; absent/`null` = track color. */
  color?: string | null | undefined;
}
