// SS10: the keyboard map "auditions at new pitch", and SS9's note in
// types/editor: auditions are UI, "they play immediately and are never
// scheduled, never recorded, never undoable" — they go through
// `AuditionSink` (the shell wires it to `ProjectEngine.auditionFor`), never
// through the transport.
//
// A drag holds its audition for as long as the pointer is down and releases it
// on commit/cancel, so it needs no timer. A KEY press has no release, so this
// tiny voice tracker gives it one: each strike releases the previous voices
// and schedules its own note-offs. The timer is injectable so tests stay
// deterministic (SS15).

import type { AuditionSink } from "../../types/editor";

export const KEY_AUDITION_HOLD_MS = 250;

export interface AuditionNote {
  readonly pitch: number;
  readonly vel: number;
}

export interface KeyboardAudition {
  /** Releases whatever is sounding, then plays these pitches. */
  strike(notes: readonly AuditionNote[]): void;
  stopAll(): void;
}

export interface KeyboardAuditionOptions {
  holdMs?: number | undefined;
  setTimer?: ((fn: () => void, ms: number) => number) | undefined;
  clearTimer?: ((handle: number) => void) | undefined;
  /** Cap on simultaneous audition voices — a select-all transpose must not
   *  fire 2,000 note-ons (SS2's budget). */
  maxVoices?: number | undefined;
}

export function createKeyboardAudition(
  sinkOf: () => AuditionSink | null,
  options: KeyboardAuditionOptions = {},
): KeyboardAudition {
  const holdMs = options.holdMs ?? KEY_AUDITION_HOLD_MS;
  const maxVoices = options.maxVoices ?? 8;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
  const clearTimer =
    options.clearTimer ??
    ((handle: number) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });

  let sounding: number[] = [];
  let timer: number | null = null;

  const release = (): void => {
    const sink = sinkOf();
    if (sink !== null) for (const pitch of sounding) sink.noteOff(pitch);
    sounding = [];
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    strike(notes: readonly AuditionNote[]): void {
      release();
      const sink = sinkOf();
      if (sink === null || notes.length === 0) return;
      for (const note of notes.slice(0, maxVoices)) {
        sink.noteOn(note.pitch, note.vel);
        sounding.push(note.pitch);
      }
      timer = setTimer(() => {
        timer = null;
        release();
      }, holdMs);
    },
    stopAll(): void {
      release();
    },
  };
}
