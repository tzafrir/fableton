// The computer keyboard as a MIDI keyboard (SS15's discipline: the mapping
// and the held-key bookkeeping are plain data + a headless FSM, so the whole
// thing is unit-testable without a browser; App.tsx only forwards events).
//
// The layout is the one every tracker and DAW uses, and the one the user
// asked for: the home row is the white keys and the row above holds the
// black keys where they physically sit on a piano.
//
//        w e     t y u     o p
//       a s d f g h j k l ;
//       C D E F G A B C D E
//
// `z` / `x` shift the octave, `c` / `v` the velocity — the two things you
// reach for while playing that a keyboard has no other way to express.
//
// AUTOREPEAT is the load-bearing detail: holding a key fires `keydown`
// forever at the OS repeat rate. Without the held-key set below, every held
// note would retrigger ~30 times a second, which is both wrong musically and
// a voice-allocator flood.

/** Key (lowercased `KeyboardEvent.key`) -> semitones above the base octave. */
export const KEY_SEMITONES: Readonly<Record<string, number>> = {
  a: 0, // C
  w: 1,
  s: 2, // D
  e: 3,
  d: 4, // E
  f: 5, // F
  t: 6,
  g: 7, // G
  y: 8,
  h: 9, // A
  u: 10,
  j: 11, // B
  k: 12, // C, an octave up
  o: 13,
  l: 14, // D
  p: 15,
  ";": 16, // E
};

export const OCTAVE_DOWN_KEY = "z";
export const OCTAVE_UP_KEY = "x";
export const VELOCITY_DOWN_KEY = "c";
export const VELOCITY_UP_KEY = "v";

/** The octave `a` plays at by default: MIDI 60, the C the key strip calls C3. */
export const DEFAULT_OCTAVE = 3;
/** Octave range that keeps every mapped key inside MIDI 0..127. */
export const MIN_OCTAVE = -1;
export const MAX_OCTAVE = 7;

export const DEFAULT_VELOCITY = 100;
export const VELOCITY_STEP = 15;

/** MIDI pitch for a key at an octave, or `null` when the key is unmapped. */
export function pitchForKey(key: string, octave: number): number | null {
  const semitone = KEY_SEMITONES[key.toLowerCase()];
  if (semitone === undefined) return null;
  const pitch = 60 + (octave - DEFAULT_OCTAVE) * 12 + semitone;
  return pitch < 0 || pitch > 127 ? null : pitch;
}

export interface KeyboardPianoSink {
  noteOn(pitch: number, velocity: number): void;
  noteOff(pitch: number): void;
}

export interface KeyboardPianoOptions {
  sink: () => KeyboardPianoSink | undefined;
  /** Told whenever the octave or velocity changes, for the on-screen readout. */
  onChange?: ((state: { octave: number; velocity: number }) => void) | undefined;
  octave?: number | undefined;
  velocity?: number | undefined;
}

/** What a handled key did — the caller uses this to decide `preventDefault`. */
export type KeyResult = "note" | "control" | "ignored";

export interface KeyboardPiano {
  readonly octave: number;
  readonly velocity: number;
  /** Currently sounding pitches, in press order. */
  held(): readonly number[];
  keyDown(key: string, options?: { repeat?: boolean | undefined }): KeyResult;
  keyUp(key: string): KeyResult;
  /** Releases everything sounding — focus loss, transport stop, unmount. */
  releaseAll(): void;
}

export function createKeyboardPiano(options: KeyboardPianoOptions): KeyboardPiano {
  let octave = clampOctave(options.octave ?? DEFAULT_OCTAVE);
  let velocity = clampVelocity(options.velocity ?? DEFAULT_VELOCITY);
  /** key -> the pitch it started, so a release finds the note it began even
   *  if the octave changed while the key was down. */
  const held = new Map<string, number>();

  const announce = (): void => options.onChange?.({ octave, velocity });

  const release = (key: string): boolean => {
    const pitch = held.get(key);
    if (pitch === undefined) return false;
    held.delete(key);
    options.sink()?.noteOff(pitch);
    return true;
  };

  return {
    get octave() {
      return octave;
    },
    get velocity() {
      return velocity;
    },
    held: () => [...held.values()],

    keyDown(key, keyOptions = {}): KeyResult {
      const lower = key.toLowerCase();
      // Autorepeat: the OS keeps firing while a key is down. A note already
      // sounding must not retrigger, and a repeated octave key must not run
      // away up the keyboard.
      if (keyOptions.repeat === true) return held.has(lower) ? "note" : "ignored";

      if (lower === OCTAVE_DOWN_KEY || lower === OCTAVE_UP_KEY) {
        const next = clampOctave(octave + (lower === OCTAVE_UP_KEY ? 1 : -1));
        if (next !== octave) {
          // Everything sounding is released first: the notes were started at
          // the old octave and their keys now mean different pitches, so a
          // later keyup could not pair them.
          for (const key2 of [...held.keys()]) release(key2);
          octave = next;
          announce();
        }
        return "control";
      }
      if (lower === VELOCITY_DOWN_KEY || lower === VELOCITY_UP_KEY) {
        const next = clampVelocity(velocity + (lower === VELOCITY_UP_KEY ? VELOCITY_STEP : -VELOCITY_STEP));
        if (next !== velocity) {
          velocity = next;
          announce();
        }
        return "control";
      }

      const pitch = pitchForKey(lower, octave);
      if (pitch === null) return "ignored";
      if (held.has(lower)) return "note"; // already sounding
      held.set(lower, pitch);
      options.sink()?.noteOn(pitch, velocity);
      return "note";
    },

    keyUp(key): KeyResult {
      const lower = key.toLowerCase();
      if (release(lower)) return "note";
      if (
        lower === OCTAVE_DOWN_KEY ||
        lower === OCTAVE_UP_KEY ||
        lower === VELOCITY_DOWN_KEY ||
        lower === VELOCITY_UP_KEY
      ) {
        return "control";
      }
      return KEY_SEMITONES[lower] === undefined ? "ignored" : "note";
    },

    releaseAll(): void {
      for (const key of [...held.keys()]) release(key);
    },
  };
}

function clampOctave(value: number): number {
  return Math.min(MAX_OCTAVE, Math.max(MIN_OCTAVE, Math.round(value)));
}

function clampVelocity(value: number): number {
  return Math.min(127, Math.max(1, Math.round(value)));
}
