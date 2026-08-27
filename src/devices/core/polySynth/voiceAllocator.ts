// Pure voice-allocation policy for `core.poly-synth` (SS7 "a voice allocator
// behind noteOn/noteOff/allNotesOff", SS14 "Adding an instrument"). No audio,
// no worklet globals — just which fixed-size voice slot a pitch should use.
// Runs identically inside the worklet processor and in a plain Vitest file.

export class VoiceAllocator {
  private readonly pitches: Array<number | null>;
  private readonly order: number[];
  private nextOrder = 0;

  constructor(readonly voiceCount: number) {
    if (!Number.isInteger(voiceCount) || voiceCount < 1) {
      throw new Error("VoiceAllocator: voiceCount must be a positive integer");
    }
    this.pitches = new Array(voiceCount).fill(null);
    this.order = new Array(voiceCount).fill(-1);
  }

  /**
   * Picks a voice for `pitch`: the LEAST-RECENTLY-USED free voice, or, once
   * every voice is busy, the oldest-triggered one is stolen — standard
   * fixed-polyphony behavior.
   *
   * Least-recently-used, not lowest-index: a released voice is still audibly
   * ringing out its envelope release (§7 "old disposed after its tail"), and
   * `AdsrEnvelope.noteOn` deliberately ramps from the current level rather
   * than resetting. Handing out slot 0 every time would make a monophonic
   * melody re-trigger one single voice and truncate every release tail; going
   * round the pool instead gives each tail the whole pool to decay in.
   *
   * A pitch already sounding gets its OWN voice rather than retriggering the
   * held one. Two notes of the same pitch on one track may overlap — nothing
   * in `MidiClip` forbids it and M1's piano roll lets a user draw it — and the
   * scheduler goes out of its way to support that: its sounding-note ledger is
   * one entry per note OCCURRENCE, deliberately not deduplicated by (pitch,
   * track) (see the ledger comment in src/engine/transport/transport.ts), so
   * each note-on is paired with exactly one note-off. Collapsing the pair onto
   * one voice here would undo that on the audio thread: the first note-off
   * would release both and the second would find nothing.
   */
  allocate(pitch: number): number {
    const free = this.lruFreeIndex();
    const index = free >= 0 ? free : this.oldestIndex();
    this.pitches[index] = pitch;
    this.order[index] = this.nextOrder++;
    return index;
  }

  /**
   * Frees ONE voice sounding `pitch` — the oldest-triggered one — and returns
   * its index, or `null` when that pitch is not sounding. Oldest first pairs
   * note-offs with note-ons in arrival order, so with two overlapping notes of
   * one pitch the second keeps sounding until its own note-off arrives.
   */
  release(pitch: number): number | null {
    let index = -1;
    let minOrder = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.pitches.length; i++) {
      if (this.pitches[i] !== pitch) continue;
      const value = this.order[i] ?? Number.POSITIVE_INFINITY;
      if (value < minOrder) {
        minOrder = value;
        index = i;
      }
    }
    if (index < 0) return null;
    this.pitches[index] = null;
    // `order` is deliberately KEPT: it is this slot's last-used stamp, which
    // is what makes the free-voice search least-recently-used.
    return index;
  }

  /**
   * Frees every voice, without allocating (this runs on the audio thread).
   *
   * The last-used stamps are KEPT, for the same reason `release` keeps them:
   * `allNotesOff` (every transport stop, seek and tempo change while playing,
   * SS12) only *releases* the voices — they are still audibly ringing out
   * their tails. Resetting the stamps here would send the pool back to
   * lowest-index allocation, so the next few notes would each steal a voice
   * that is still sounding and truncate its release.
   */
  clear(): void {
    for (let i = 0; i < this.pitches.length; i++) {
      this.pitches[i] = null;
    }
  }

  /** The pitch currently occupying a voice, or `null` when it is free. */
  pitchOf(index: number): number | null {
    return this.pitches[index] ?? null;
  }

  /** Free voice with the oldest last-use stamp; -1 when every voice is busy.
   *  Never-used slots (stamp -1) come first — they are silent for certain. */
  private lruFreeIndex(): number {
    let index = -1;
    let minOrder = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.pitches.length; i++) {
      if (this.pitches[i] !== null) continue;
      const value = this.order[i] ?? -1;
      if (value < minOrder) {
        minOrder = value;
        index = i;
      }
    }
    return index;
  }

  private oldestIndex(): number {
    let index = 0;
    let minOrder = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.order.length; i++) {
      const value = this.order[i] ?? Number.POSITIVE_INFINITY;
      if (value < minOrder) {
        minOrder = value;
        index = i;
      }
    }
    return index;
  }
}
