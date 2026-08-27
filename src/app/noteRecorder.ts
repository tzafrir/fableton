// Turning played notes into document notes (SS10/SS12).
//
// Headless and clock-free: the caller supplies "what tick is it now", which
// is `transport.positionTicks()` live and a stub in tests. That keeps the
// only genuinely tricky part — pairing note-ons with note-offs across a loop
// wrap, and closing whatever is still held when recording stops — testable
// without an AudioContext.
//
// Ticks here are SONG ticks; the caller subtracts the clip's start (a note's
// position is clip-relative, SS10) when it writes them into a clip.

import type { Ticks } from "../types";

/** The minimum a recorded note can be — invariant 5 says `dur >= 1`, and a
 *  note tapped shorter than a tick still has to be visible and grabbable. */
export const MIN_RECORDED_DUR_TICKS = 30;

export interface RecordedNote {
  pitch: number;
  vel: number;
  start: Ticks;
  dur: Ticks;
}

export interface NoteRecorder {
  /** True once anything has been played into it. */
  readonly hasNotes: boolean;
  noteOn(pitch: number, velocity: number): void;
  noteOff(pitch: number): void;
  /** Closes every still-held note at `now` and returns the take, sorted by
   *  (start, pitch) — the order the document keeps notes in (invariant 4). */
  finish(): RecordedNote[];
  reset(): void;
}

export function createNoteRecorder(now: () => Ticks): NoteRecorder {
  const done: RecordedNote[] = [];
  /** pitch -> the open note's start and velocity. Only one note per pitch can
   *  be open at a time: a keyboard cannot press the same key twice. */
  const open = new Map<number, { start: Ticks; vel: number }>();

  const close = (pitch: number, entry: { start: Ticks; vel: number }, at: Ticks): void => {
    // A loop wrap sends `now` backwards mid-note. Rather than record a
    // negative-length note (or silently drop it), keep the note at its
    // minimum length: the take stays complete and nothing is a lie about
    // when it started.
    const dur = Math.max(MIN_RECORDED_DUR_TICKS, Math.round(at - entry.start));
    done.push({ pitch, vel: entry.vel, start: entry.start, dur });
  };

  return {
    get hasNotes() {
      return done.length > 0 || open.size > 0;
    },

    noteOn(pitch, velocity): void {
      const at = Math.round(now());
      const existing = open.get(pitch);
      // Defensive: a note-on for an already-open pitch closes the first one,
      // so a missed note-off cannot swallow the rest of the take.
      if (existing !== undefined) close(pitch, existing, at);
      open.set(pitch, { start: at, vel: Math.min(127, Math.max(1, Math.round(velocity))) });
    },

    noteOff(pitch): void {
      const entry = open.get(pitch);
      if (entry === undefined) return;
      open.delete(pitch);
      close(pitch, entry, Math.round(now()));
    },

    finish(): RecordedNote[] {
      const at = Math.round(now());
      for (const [pitch, entry] of open) close(pitch, entry, at);
      open.clear();
      const take = [...done].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      done.length = 0;
      return take;
    },

    reset(): void {
      done.length = 0;
      open.clear();
    },
  };
}
