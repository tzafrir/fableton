// Voice allocation with a RUNTIME limit — `core.wavetable`'s Voices param.
//
// `core.poly-synth`'s allocator (../polySynth/voiceAllocator.ts) is fixed at
// construction, which is right for a synth whose polyphony is a constant. It
// is not enough here: lowering Voices has to take effect on the next note,
// and re-constructing an allocator would throw away the pitch->slot map that
// every held note's note-off is waiting on.
//
// So the pool is always `capacity` slots wide and only the first `limit` of
// them are handed out. Slots above the limit are not cleared when the limit
// drops — a voice that was legally allocated is still audibly ringing, and
// cutting it because a knob moved is a click. They simply stop being reused.

export class VoicePool {
  private readonly pitches: Array<number | null>;
  private readonly order: number[];
  private nextOrder = 0;
  private cap: number;

  constructor(readonly capacity: number) {
    this.pitches = new Array<number | null>(capacity).fill(null);
    this.order = new Array<number>(capacity).fill(-1);
    this.cap = capacity;
  }

  get limit(): number {
    return this.cap;
  }

  setLimit(limit: number): void {
    const n = Math.round(limit);
    this.cap = n < 1 ? 1 : n > this.capacity ? this.capacity : n;
  }

  /** Least-recently-used free slot under the limit, or the oldest one there.
   *  Same policy as the poly synth's: going round the pool lets each release
   *  tail decay in peace instead of being truncated by the next note. */
  allocate(pitch: number): number {
    let index = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.cap; i++) {
      if (this.pitches[i] !== null) continue;
      const stamp = this.order[i] ?? -1;
      if (stamp < best) {
        best = stamp;
        index = i;
      }
    }
    if (index < 0) {
      best = Number.POSITIVE_INFINITY;
      index = 0;
      for (let i = 0; i < this.cap; i++) {
        const stamp = this.order[i] ?? Number.POSITIVE_INFINITY;
        if (stamp < best) {
          best = stamp;
          index = i;
        }
      }
    }
    this.pitches[index] = pitch;
    this.order[index] = this.nextOrder++;
    return index;
  }

  /** Frees the OLDEST slot sounding `pitch` — one note-off per note-on, even
   *  when two notes of the same pitch overlap. */
  release(pitch: number): number | null {
    let index = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.pitches.length; i++) {
      if (this.pitches[i] !== pitch) continue;
      const stamp = this.order[i] ?? Number.POSITIVE_INFINITY;
      if (stamp < best) {
        best = stamp;
        index = i;
      }
    }
    if (index < 0) return null;
    this.pitches[index] = null;
    return index;
  }

  clear(): void {
    for (let i = 0; i < this.pitches.length; i++) this.pitches[i] = null;
  }

  pitchOf(index: number): number | null {
    return this.pitches[index] ?? null;
  }
}
