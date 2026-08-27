// SS8 — Musical time model.
//
// All musical positions and lengths are INTEGER ticks at 960 PPQ. Seconds
// never appear in the document; conversion happens in exactly two places —
// the scheduler (ticks -> AudioContext seconds) and the time ruler
// (formatting bar.beat.tick).
//
// Implemented by the `time-model` package in src/time/.

import type { Seconds } from "./common";

/**
 * Musical position or length in ticks. ALWAYS an integer — fractional ticks
 * are a bug (they break equality, snapping and stable serialization).
 * Rounding happens at the seconds->ticks boundary only.
 */
export type Ticks = number;

/** Beats per minute (quarter notes per minute). */
export type Bpm = number;

/**
 * Pulses per quarter note. The single source of truth for the whole app:
 * a 1/16 note is exactly `PPQ / 4` = 240 ticks. This is a constant, not an
 * implementation — src/time/ must not redeclare it.
 */
export const PPQ = 960;

/** Ticks per whole note at `PPQ` (4 * PPQ = 3840). */
export const TICKS_PER_WHOLE_NOTE = PPQ * 4;

/**
 * One constant-tempo segment. `startTick` is where the segment begins; it
 * runs until the next segment's `startTick` (or forever, for the last one).
 * Segments are sorted by `startTick` and the first one starts at tick 0.
 */
export interface TempoSegment {
  startTick: Ticks;
  bpm: Bpm;
}

/**
 * Owns tick<->seconds conversion via piecewise integration over its
 * segments. v1 ships a single fixed-tempo segment, but every engine API
 * takes the map, so tempo automation later is a data change, not a
 * refactor.
 *
 * Invariants: `segments` is non-empty, sorted, and `segments[0].startTick`
 * is 0. `secondsAt` is monotonically increasing and `secondsAt(0) === 0`.
 */
export interface TempoMap {
  readonly segments: readonly TempoSegment[];
  /** Ticks per quarter note this map is expressed in (always `PPQ`). */
  readonly ppq: number;
  /** Song time in seconds at a musical position (tick 0 -> 0 s). */
  secondsAt(tick: Ticks): Seconds;
  /** Inverse of `secondsAt`; result is rounded to an integer tick. */
  ticksAt(seconds: Seconds): Ticks;
  /** Duration in seconds of the span [fromTick, toTick). May be negative. */
  secondsBetween(fromTick: Ticks, toTick: Ticks): Seconds;
  /** Tempo in effect at a position. */
  bpmAt(tick: Ticks): Bpm;
}

/** Bar/beat subdivision for the ruler and bar math (4/4 in M0). */
export interface TimeSignature {
  numerator: number;
  /** Note value of one beat: 4 = quarter, 8 = eighth. */
  denominator: number;
}

/** Ruler-facing decomposition: `bar.beat.tick`, all 1-based except `tick`. */
export interface BarBeatTick {
  bar: number;
  beat: number;
  tick: Ticks;
}
