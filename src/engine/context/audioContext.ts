// Audio context boot + unlock.
//
// SS12 guardrails: `latencyHint:'interactive'`, and the context is created
// SUSPENDED — `unlockAudioContextOnGesture` (./unlock) resumes it on the
// first user gesture.
//
// No worklet is loaded here. SS15's worklet-bundling seam belongs to the
// device that owns the processor — see `core.poly-synth`'s `prepare()`
// (src/devices/core/polySynth.ts), which the device host awaits once per
// context (SS7 "prepare: one-time async setup per context"). A context-wide
// do-nothing processor loaded on every boot would only be scaffolding in the
// shipped bundle.

/**
 * Options accepted by {@link createAudioContext}. Mirrors the subset of
 * `AudioContextOptions` this app cares about, kept local so callers don't
 * need a DOM-lib import just to pass `latencyHint` through.
 */
export interface CreateAudioContextOptions {
  /**
   * Forwarded to the `AudioContext` constructor. Defaults to `"interactive"`
   * per the SS12 guardrail (`latencyHint:'interactive'`) — the browser's
   * lowest-latency-safe buffer size for a live-playing instrument, as
   * opposed to `"playback"` (favors glitch-free over latency) or
   * `"balanced"`.
   */
  latencyHint?: AudioContextLatencyCategory | number | undefined;
}

/**
 * Creates (but does not resume) an AudioContext.
 *
 * Does not attempt to resume the context — most browsers hand back a
 * `"suspended"` context until a user gesture unlocks it; see
 * `unlockAudioContextOnGesture` (./unlock) and `bootAudioContext` (./boot)
 * for the SS12 unlock guardrail. Kept separate so callers that already have
 * their own gesture-timing needs (e.g. tests) can still get a bare context.
 */
export function createAudioContext(
  options?: CreateAudioContextOptions
): AudioContext {
  return new AudioContext({ latencyHint: options?.latencyHint ?? "interactive" });
}
