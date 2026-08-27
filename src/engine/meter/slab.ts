// SS6 "Metering" — the SharedArrayBuffer slab both threads agree on.
//
// "A tiny metering worklet per strip writes peak/RMS into a
// SharedArrayBuffer slab; the UI reads it at rAF." One writer per slot (that
// strip's worklet), one reader (the UI), floats written atomically enough
// for meters: a torn read costs one frame of one meter and heals itself.
// Everything here is pure slab math so it unit-tests without any audio.

export const FLOATS_PER_SLOT = 2;
export const PEAK_OFFSET = 0;
export const RMS_OFFSET = 1;

/** Slots per slab; a slab covers this many strips before a second allocates. */
export const DEFAULT_SLOT_COUNT = 64;

export function slabByteLength(slots: number): number {
  return slots * FLOATS_PER_SLOT * Float32Array.BYTES_PER_ELEMENT;
}

/** The float index of a slot's field. */
export function slotIndex(slot: number, offset: number): number {
  return slot * FLOATS_PER_SLOT + offset;
}

/** Writer side (worklet): stores one block's peak + rms into `slot`. */
export function writeMeterSlot(view: Float32Array, slot: number, peak: number, rms: number): void {
  view[slotIndex(slot, PEAK_OFFSET)] = peak;
  view[slotIndex(slot, RMS_OFFSET)] = rms;
}

/** Reader side (UI): the raw values as last written. */
export function readMeterSlot(view: Float32Array, slot: number): { peak: number; rms: number } {
  return {
    peak: view[slotIndex(slot, PEAK_OFFSET)] ?? 0,
    rms: view[slotIndex(slot, RMS_OFFSET)] ?? 0,
  };
}

/**
 * Peak + RMS of one (or two summed) channel blocks, written into `out` as
 * `[peak, rms]` — the worklet's math, shared here so the fallback path and
 * the tests use the same numbers.
 *
 * Out-param, and index loops rather than `for...of`, because this runs inside
 * `AudioWorkletProcessor.process`: SS12's guardrail is "zero allocation in
 * per-tick paths", and a returned object plus two array iterators per render
 * quantum per metered strip is ~6,000 short-lived allocations a second at
 * SS2's 16-track target. `blockPeakRms` below is the same math for the
 * main-thread callers, where an object is the nicer shape.
 */
export function blockPeakRmsInto(channels: readonly Float32Array[], out: Float32Array): void {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (let c = 0; c < channels.length; c++) {
    const samples = channels[c];
    if (samples === undefined) continue;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] ?? 0;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
      sumSquares += v * v;
      count += 1;
    }
  }
  out[PEAK_OFFSET] = peak;
  out[RMS_OFFSET] = count === 0 ? 0 : Math.sqrt(sumSquares / count);
}

/** `blockPeakRmsInto` as an object — the main-thread analyser fallback and
 *  the tests, never the render thread. */
export function blockPeakRms(channels: readonly Float32Array[]): { peak: number; rms: number } {
  const out = new Float32Array(FLOATS_PER_SLOT);
  blockPeakRmsInto(channels, out);
  return { peak: out[PEAK_OFFSET] ?? 0, rms: out[RMS_OFFSET] ?? 0 };
}

/**
 * Meter ballistics, applied by the READER at rAF (SS6: the writer stays a
 * raw block measurement). Instant attack, exponential release — the familiar
 * fall of a digital peak meter.
 */
export function decayed(previous: number, next: number, dtSeconds: number, releasePerSecond = 12): number {
  if (next >= previous) return next;
  const fallen = previous * Math.exp(-releasePerSecond * dtSeconds);
  return Math.max(next, fallen);
}
