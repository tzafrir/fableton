// Pending-event ring for `core.poly-synth`'s worklet. `noteOn` / `noteOff` /
// `allNotesOff` arrive as `port.onmessage` calls (main thread -> worklet, §12
// "exact context timestamps") in any order and possibly well ahead of when
// they should sound (`DEFAULT_LOOKAHEAD_SECONDS` = 0.2 s, many render quanta
// away). This queue holds them until `sampleOffsetForBlock` says they belong
// to the block currently rendering.
//
// §12 guardrail — "zero allocation in per-tick paths (preallocated event
// objects, ring buffers for messages)". This runs on the AUDIO RENDER thread,
// where a GC pause costs a dropout, so the queue is exactly that ring: the
// incoming message object's fields are copied into preallocated typed arrays
// and the object is dropped immediately; `collectDue` sorts in place into a
// second set of preallocated arrays and returns a count. Nothing here
// allocates after construction — no arrays, no wrapper objects, no closures.
//
// `allNotesOff` additionally CANCELS: every queued event at or after its
// timestamp is dropped. Without that, `transport.stop()` cannot silence the
// instrument at all — the look-ahead window has already handed the worklet up
// to 200 ms of future note-ons, and a compensating note-off cannot retract a
// note-on that has not attacked yet (§12 "Stop sends allNotesOff(now + e)
// down every track"). The purge happens at push time, not at apply time, so
// events pushed AFTER the panic (a seek's fresh window starts within the same
// epsilon) are unaffected.

import { sampleOffsetForBlock } from "./scheduling";

/** The postMessage payload shape (main thread -> worklet). */
export type QueuedNoteEvent =
  | { type: "noteOn"; pitch: number; vel: number; when: number }
  | { type: "noteOff"; pitch: number; when: number }
  | { type: "allNotesOff"; when: number };

/** Event kind as stored in the ring — an integer, so the ring stays typed. */
export const NOTE_ON = 0;
export const NOTE_OFF = 1;
export const ALL_NOTES_OFF = 2;
export type NoteEventCode = typeof NOTE_ON | typeof NOTE_OFF | typeof ALL_NOTES_OFF;

/** 200 ms of look-ahead cannot plausibly hold this many events per voice. */
const DEFAULT_CAPACITY = 1024;

/** `-1` for anything this queue does not recognise — see `push`. */
function codeOf(type: string): NoteEventCode | -1 {
  if (type === "noteOn") return NOTE_ON;
  if (type === "noteOff") return NOTE_OFF;
  if (type === "allNotesOff") return ALL_NOTES_OFF;
  return -1;
}

export class NoteEventQueue {
  readonly capacity: number;

  // --- pending (not yet due) ------------------------------------------------
  private readonly pendType: Int8Array;
  private readonly pendPitch: Int32Array;
  private readonly pendVel: Float32Array;
  private readonly pendWhen: Float64Array;
  private pendCount = 0;

  // --- due in the block being rendered, ordered by sample offset ------------
  private readonly dType: Int8Array;
  private readonly dPitch: Int32Array;
  private readonly dVel: Float32Array;
  private readonly dOffset: Int32Array;
  private dCount = 0;

  private droppedCount = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.pendType = new Int8Array(capacity);
    this.pendPitch = new Int32Array(capacity);
    this.pendVel = new Float32Array(capacity);
    this.pendWhen = new Float64Array(capacity);
    this.dType = new Int8Array(capacity);
    this.dPitch = new Int32Array(capacity);
    this.dVel = new Float32Array(capacity);
    this.dOffset = new Int32Array(capacity);
  }

  /** Events waiting for their block. */
  get size(): number {
    return this.pendCount;
  }

  /** Events refused because the ring was full. Diagnostics only. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Copies one incoming message into the ring. An `allNotesOff` first drops
   * every queued event at or after its own timestamp (see the header): "all
   * notes off at T" must also mean "nothing scheduled at or after T sounds".
   *
   * `port.onmessage` is an untrusted boundary — the same way the clock
   * worker's `asCommand` narrowing treats its own input — so a message that
   * is not one of the three known shapes is DROPPED, not coerced. Mapping an
   * unknown `type` to `ALL_NOTES_OFF` (what a bare `else` does) degrades as
   * badly as it can on the render thread: `cancelFrom(undefined)` silently
   * purges nothing (`x >= undefined` is always false), `when` stores as
   * `NaN`, and `sampleOffsetForBlock` maps that to offset 0 — so one
   * malformed message releases every voice at the top of the next quantum.
   */
  push(event: QueuedNoteEvent): void {
    const code = codeOf((event as { type?: unknown }).type as string);
    if (code === -1 || !Number.isFinite(event.when)) {
      this.droppedCount++;
      return;
    }
    if (code === ALL_NOTES_OFF) this.cancelFrom(event.when);
    if (this.pendCount === this.capacity) {
      this.droppedCount++;
      return;
    }
    const i = this.pendCount;
    this.pendType[i] = code;
    this.pendPitch[i] = code === ALL_NOTES_OFF ? -1 : (event as { pitch: number }).pitch;
    this.pendVel[i] = code === NOTE_ON ? (event as { vel: number }).vel : 0;
    this.pendWhen[i] = event.when;
    this.pendCount++;
  }

  /** Drops every queued event whose `when` is at or after `from`. */
  private cancelFrom(from: number): void {
    let write = 0;
    for (let i = 0; i < this.pendCount; i++) {
      if (this.pendWhen[i]! >= from) continue;
      if (write !== i) {
        this.pendType[write] = this.pendType[i]!;
        this.pendPitch[write] = this.pendPitch[i]!;
        this.pendVel[write] = this.pendVel[i]!;
        this.pendWhen[write] = this.pendWhen[i]!;
      }
      write++;
    }
    this.pendCount = write;
  }

  /**
   * Moves every event due within the block starting at `blockStartSeconds`
   * into the due buffer, ordered by sample offset (ties keep arrival order),
   * and returns how many there are. Read them back with `typeAt` / `pitchAt` /
   * `velAt` / `offsetAt`; they stay valid until the next `collectDue`.
   */
  collectDue(blockStartSeconds: number, sampleRate: number, blockSize: number): number {
    this.dCount = 0;
    let write = 0;
    for (let i = 0; i < this.pendCount; i++) {
      const offset = sampleOffsetForBlock(
        this.pendWhen[i]!,
        blockStartSeconds,
        sampleRate,
        blockSize,
      );
      if (offset === null) {
        // Not yet: compact it back down into the pending region.
        if (write !== i) {
          this.pendType[write] = this.pendType[i]!;
          this.pendPitch[write] = this.pendPitch[i]!;
          this.pendVel[write] = this.pendVel[i]!;
          this.pendWhen[write] = this.pendWhen[i]!;
        }
        write++;
        continue;
      }
      this.insertDue(this.pendType[i]!, this.pendPitch[i]!, this.pendVel[i]!, offset);
    }
    this.pendCount = write;
    return this.dCount;
  }

  /** Stable insertion sort by offset — n is tiny and this allocates nothing. */
  private insertDue(type: number, pitch: number, vel: number, offset: number): void {
    let j = this.dCount - 1;
    while (j >= 0 && this.dOffset[j]! > offset) {
      this.dType[j + 1] = this.dType[j]!;
      this.dPitch[j + 1] = this.dPitch[j]!;
      this.dVel[j + 1] = this.dVel[j]!;
      this.dOffset[j + 1] = this.dOffset[j]!;
      j--;
    }
    this.dType[j + 1] = type;
    this.dPitch[j + 1] = pitch;
    this.dVel[j + 1] = vel;
    this.dOffset[j + 1] = offset;
    this.dCount++;
  }

  typeAt(index: number): NoteEventCode {
    return (this.dType[index] ?? ALL_NOTES_OFF) as NoteEventCode;
  }

  pitchAt(index: number): number {
    return this.dPitch[index] ?? 0;
  }

  velAt(index: number): number {
    return this.dVel[index] ?? 0;
  }

  /** Sample index within the block currently rendering, in `[0, blockSize)`. */
  offsetAt(index: number): number {
    return this.dOffset[index] ?? 0;
  }
}
