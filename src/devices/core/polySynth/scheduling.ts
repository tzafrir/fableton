// Pure sample-accurate scheduling math for `core.poly-synth`'s worklet
// (SS12: "instruments must schedule, never fire immediately"; `when` is an
// audio-clock second that may land inside a future render quantum). No
// worklet globals — this is the one piece of that math worth unit-testing
// head-on; the processor itself just calls it once per block.

/**
 * Where, within the render quantum starting at `blockStartSeconds`, `when`
 * falls — as a sample offset in `[0, blockSize)` — or `null` if `when` is
 * still in a future block. A `when` at or before the block start clamps to
 * offset 0 (SS7: `create()` may receive events whose time has already
 * passed by the time this block renders; still schedule it, don't drop it).
 */
export function sampleOffsetForBlock(
  when: number,
  blockStartSeconds: number,
  sampleRate: number,
  blockSize: number,
): number | null {
  if (!Number.isFinite(when)) return 0;
  const rawOffset = Math.round((when - blockStartSeconds) * sampleRate);
  if (rawOffset < 0) return 0;
  if (rawOffset >= blockSize) return null;
  return rawOffset;
}
