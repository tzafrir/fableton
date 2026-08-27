// Small cross-cutting aliases shared by every other type module.
//
// Owned by the interface author (src/types is a frozen contract for M0).
// Interfaces and type aliases only — no runtime behaviour lives here.

/** Unsubscribe callback returned by every `on*` subscription in the app. */
export type Unsub = () => void;

/**
 * Time on the audio clock, in seconds, in the same frame of reference as
 * `BaseAudioContext.currentTime`. Every `when` argument crossing a seam
 * (scheduler -> instrument, ParamHandle -> AudioParam/message) is a
 * `Seconds` value on that clock — never a `Date.now()` / `performance.now()`
 * value, and never a musical position (see `Ticks` in ./time).
 */
export type Seconds = number;

/** Wall-clock duration in milliseconds (timer intervals, smoothing times). */
export type Milliseconds = number;

/**
 * A 0..1 value produced by mapping a real-unit param value through its
 * taper. Normalization exists ONLY at that mapping boundary (SS4 "Value
 * semantics"): documents, descriptors and handles always carry real units.
 */
export type Normalized = number;
