// SS12 — Transport & scheduling.
//
// Classic two-clock design: `BaseAudioContext.currentTime` is the only truth
// for *when*; the JS timer (in a dedicated Worker, because main-thread
// timers throttle in background tabs) only decides *how far ahead* to
// schedule. Note events are handed exact context timestamps, so jitter in
// the tick loop never reaches the audio.
//
// Implemented by `scheduler-transport` (src/engine/transport/, src/workers/).

import type { Milliseconds, Seconds, Unsub } from "./common";
import type { ChannelId } from "./ids";
import type { MidiClip } from "./clip";
import type { TempoMap, Ticks } from "./time";

/** SS12 worker clock period: `setInterval(() => post('tick'), 25)`. */
export const DEFAULT_TICK_INTERVAL_MS = 25;

/** SS12 look-ahead horizon: `ctx.currentTime + 0.20`. */
export const DEFAULT_LOOKAHEAD_SECONDS = 0.2;

/** SS12: `stopped -> playing -> recording` (record = playing + capture flag). */
export type TransportState = "stopped" | "playing" | "recording";

/** Transport loop brace, in absolute song ticks. */
export interface LoopRegion {
  start: Ticks;
  end: Ticks;
  enabled: boolean;
}

// --- scheduler-facing event stream -----------------------------------------

export type NoteEventType = "noteOn" | "noteOff";

/**
 * One note event at an absolute song position, before tick->seconds
 * conversion. Produced by a `NoteEventSource`, consumed by the scheduler.
 *
 * ALLOCATION CONTRACT (SS12 "zero allocation in per-tick paths"): a source
 * may yield the same mutable object repeatedly. Consumers must read what
 * they need before advancing the iterator and must never retain the object.
 * The same licence — and the same obligation — covers the iterable and its
 * iterator; see `NoteEventSource.eventsInRange`.
 */
export interface NoteEvent {
  readonly type: NoteEventType;
  /** Absolute song position in ticks. */
  readonly tick: Ticks;
  /** Channel whose instrument receives the event. */
  readonly trackId: ChannelId;
  /** MIDI pitch 0-127. */
  readonly pitch: number;
  /** MIDI velocity 1-127; ignored for `noteOff`. */
  readonly vel: number;
}

/**
 * Walks clips in tick order, unrolling clip loops and the transport loop
 * brace on the fly (SS12).
 */
export interface NoteEventSource {
  /**
   * Events with `fromTick <= tick < toTick`, in non-decreasing tick order.
   * Called once per worker tick with the next look-ahead window; windows are
   * contiguous and non-overlapping while playing, except after an
   * `onDiscontinuity()`.
   *
   * ALLOCATION CONTRACT (SS12): this is a per-tick path, so the returned
   * iterable, the iterator it hands out and the events it yields may all be
   * the same preallocated objects on every call — a `function*` generator
   * allocates a generator per window plus a result object per event and is
   * NOT an acceptable implementation. The consumer therefore gets one live
   * iteration at a time: it must finish (or abandon) one window's iteration
   * before calling `eventsInRange` again, and must retain nothing from it.
   */
  eventsInRange(fromTick: Ticks, toTick: Ticks): Iterable<NoteEvent>;
  /**
   * Optional. The transport calls this when the NEXT window does not continue
   * the previous one — `seek`, a tempo-map swap, the start of a playback pass,
   * a loop-brace wrap, or a stall re-anchor. In every one of those cases the
   * transport has already released whatever it had scheduled (`allNotesOff` /
   * an explicit cut), so a note whose note-on this pass never emitted must not
   * get a note-off either: the `NoteTarget` contract is that note-ons and
   * note-offs are paired, and an unpaired note-off would release a live voice
   * of the same pitch.
   *
   * A source cannot infer this from the tick stream alone — a seek may land
   * exactly on the previous window's `toTick`, and a stall re-anchor keeps the
   * ticks contiguous while breaking time — which is why the transport says so
   * explicitly.
   */
  onDiscontinuity?(): void;
  /** Latest tick at which this source can still produce an event. */
  endTick(): Ticks;
}

/** M0's clip-backed source factory (exported by src/engine/transport/). */
export type CreateClipEventSource = (
  clips: readonly MidiClip[],
) => NoteEventSource;

/**
 * What the scheduler ultimately calls. Satisfied by any instrument
 * `DeviceInstance` (its note methods are optional there and required here,
 * so the demo/engine adapts one to the other at the wiring point).
 */
export interface NoteTarget {
  noteOn(pitch: number, vel: number, when: Seconds): void;
  noteOff(pitch: number, when: Seconds): void;
  allNotesOff(when: Seconds): void;
}

/** Resolves a clip's `trackId` to the instrument that should sound it. */
export type NoteTargetResolver = (trackId: ChannelId) => NoteTarget | undefined;

/**
 * Anything else that needs filling out to the same horizon on each tick —
 * M3's automation sampler (`autoSampler.fillWindow(horizon)`) registers here
 * without the transport growing a dependency on it.
 */
export interface WindowFiller {
  /** `fromTick`/`toTick` describe the same window in musical time. */
  fillWindow(horizonSeconds: Seconds, fromTick: Ticks, toTick: Ticks): void;
}

// --- transport --------------------------------------------------------------

/** Everything the transport needs; assembled by the demo/app wiring. */
export interface TransportDeps {
  context: BaseAudioContext;
  tempoMap: TempoMap;
  events: NoteEventSource;
  resolveTarget: NoteTargetResolver;
  loop?: LoopRegion | undefined;
  /** Look-ahead horizon (SS12's 200 ms). Must exceed the tick period for the
   *  two-clock design to work at all, so the transport RAISES anything
   *  shorter than `tickIntervalMs` plus a small lead to that floor: a window
   *  narrower than the gap between ticks would schedule less music than each
   *  tick consumes and playback would silently drag behind real time. */
  lookAheadSeconds?: Seconds | undefined;
  tickIntervalMs?: Milliseconds | undefined;
}

/**
 * SS12. `positionTicks()` is UI-facing: it maps `ctx.currentTime` back
 * through the TempoMap at rAF and is the only thing the playhead reads.
 *
 * Invariants: `play()` resumes from `positionTicks()` unless given a tick;
 * `stop()` sends `allNotesOff(now + epsilon)` to every resolved target and
 * parks the position at the start point.
 */
export interface Transport {
  readonly state: TransportState;
  readonly tempoMap: TempoMap;
  /** Current song position in ticks (integer). */
  positionTicks(): Ticks;
  /** Current song position in audio-clock seconds. */
  positionSeconds(): Seconds;
  play(fromTick?: Ticks): void;
  stop(): void;
  /** Moves the playhead; allowed while stopped or playing. */
  seek(tick: Ticks): void;
  setTempoMap(map: TempoMap): void;
  /**
   * The `NoteEventSource` now yields different material than it did — the
   * document's clips were edited mid-playback.
   *
   * This CANNOT be inferred by the source or handled inside it. A fresh scan
   * suppresses the note-offs of notes whose note-on it never emitted (it has
   * to: an unpaired note-off cuts a live voice on any instrument that voices
   * overlapping same-pitch notes separately), so without this call every note
   * sounding at the moment of the edit — and every note-on already scheduled
   * into the look-ahead window — loses its note-off and hangs until the
   * transport next stops.
   *
   * Implementations re-anchor: release what is sounding and pending, then
   * schedule fresh from the current position. Notes held across the edit are
   * therefore cut, which is the honest trade — the alternative is a stuck
   * note. Callers must only call it when the note DATA changed; a param edit
   * must leave playback alone.
   */
  notesChanged(): void;
  setLoop(loop: LoopRegion | null): void;
  addWindowFiller(filler: WindowFiller): Unsub;
  onStateChange(cb: (state: TransportState) => void): Unsub;
  /** Stops the worker clock and releases subscriptions. */
  dispose(): void;
}

/** Signature of the exported transport factory (src/engine/transport/). */
export type CreateTransport = (deps: TransportDeps) => Transport;

// --- worker clock protocol --------------------------------------------------

/** Main thread -> clock worker. */
export type ClockCommand =
  | {
      type: "start";
      intervalMs: Milliseconds;
      /** Run id, echoed back on every tick of this run — see
       *  `ClockTickMessage.epoch`. */
      epoch: number;
    }
  | { type: "stop" };

/**
 * Clock worker -> main thread. `seq` increments per tick, for drop detection.
 *
 * `epoch` is the `start` command's run id. `stop` is only a message: ticks the
 * worker already posted are still in the main thread's task queue and arrive
 * AFTER the transport stopped and possibly after the next `start` reset the
 * sequence — counting those as dropped ticks would make the scheduler's only
 * health diagnostic lie after every stop/play. The receiver ignores any tick
 * whose epoch is not the current run's.
 */
export interface ClockTickMessage {
  type: "tick";
  seq: number;
  epoch: number;
}
