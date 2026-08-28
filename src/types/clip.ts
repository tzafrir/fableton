// SS10 — MIDI data model (the minimum M0 needs for its hard-coded clip).
//
// MIDI data is instrument-agnostic by construction (SS7 swap semantics):
// nothing in here references a device, only the channel that hosts it.

import type { AssetId, ChannelId, ClipId, NoteId } from "./ids";
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

/**
 * A clip that plays an imported audio file (`Project.assets`) instead of
 * notes.
 *
 * It lives in its OWN map (`Project.audioClips`) rather than in `clips`
 * beside the MIDI ones. The two are the same THING to the arrangement — a
 * rectangle on a lane, with a start and a length, that moves and trims — and
 * a completely different thing to everyone else: the piano roll, the note
 * commands, the note scheduler and the MIDI export all speak `MidiClip` and
 * would each have to learn to skip a kind they can do nothing with. Separate
 * maps keep that knowledge in the one place that needs it, which is how
 * `lanes` and `racks` are already arranged.
 *
 * `kind` is present so the arrangement — the one place holding both — can
 * discriminate the union. `MidiClip` deliberately has no such field: adding
 * one would invalidate every clip literal in the codebase to describe a
 * distinction only one file makes.
 */
export interface AudioClip {
  kind: "audio";
  id: ClipId;
  trackId: ChannelId;
  /** Position on the timeline, in ticks, exactly as `MidiClip.start`. */
  start: Ticks;
  length: Ticks;
  /** The file it plays; a key into `Project.assets`. */
  assetId: AssetId;
  /**
   * Where playback starts INSIDE the file, in SAMPLE FRAMES of that asset.
   *
   * Frames, not seconds and not ticks: an offset into a file is not musical
   * time (SS8's "no seconds in the document" is about song positions), and
   * frames are exact and independent of both the tempo map and the playback
   * device's sample rate.
   */
  offsetFrames: number;
  /** Clip gain in dB, applied on top of the track's fader. */
  gainDb: number;
  /** Arrangement-visible label; absent means "show the file's name". */
  name?: string | undefined;
  /** CSS color override; absent/`null` = track color. */
  color?: string | null | undefined;
}
