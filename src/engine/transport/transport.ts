// SS12 — Transport & look-ahead scheduler.
//
//   // engine, on each tick:
//   const horizon = ctx.currentTime + 0.20;                  // 200 ms
//   for (const ev of events.until(horizon)) schedule(ev);    // noteOn/Off
//   autoSampler.fillWindow(horizon);                         // SS11
//
// The worker clock decides only *how far ahead* to look; every timestamp
// handed to an instrument comes from the TempoMap on the
// `BaseAudioContext.currentTime` clock (SS8: "conversion happens in exactly
// two places — the scheduler and the time ruler"), so jitter in the tick loop
// never reaches the audio.
//
// Everything is written against `BaseAudioContext`, so M4's export path is
// this same transport driven by a manual clock on an `OfflineAudioContext`.
//
// Guardrail from SS12: zero allocation in per-tick paths. The scheduling loop
// allocates nothing — no iterators over subscriber arrays, no event objects
// (the source reuses one, per the `NoteEvent` allocation contract), no
// closures, and the position / pending-note / sounding-note bookkeeping all
// lives in preallocated typed arrays.

import type {
  ChannelId,
  CreateTransport,
  LoopRegion,
  NoteTarget,
  Seconds,
  Ticks,
  Transport,
  TransportDeps,
  TransportState,
  Unsub,
  WindowFiller,
} from "../../types";
import { DEFAULT_LOOKAHEAD_SECONDS, DEFAULT_TICK_INTERVAL_MS } from "../../types";
import type { Clock, ClockKind } from "./clock";
import { createDefaultClock } from "./clock";

/**
 * Offset applied to `allNotesOff` and to the release of already-scheduled
 * note-ons when the transport stops (SS12: "Stop sends `allNotesOff(now + e)`
 * down every track"). Big enough to stay ahead of the audio thread's current
 * render quantum, small enough to read as instant.
 */
const STOP_EPSILON_SECONDS = 0.005;

/** Playback starts this far ahead of `currentTime` so the first events of the
 *  first window still carry a future timestamp. */
const START_LEAD_SECONDS = 0.005;

/** Passes through the loop brace allowed in one tick. A pathologically short
 *  brace would otherwise spin here; the guard keeps the tick bounded and the
 *  next tick simply continues. */
const MAX_PASSES_PER_TICK = 64;

/** Playback passes retained for `positionTicks()`; each loop wrap starts a
 *  new one. Sized well past `MAX_PASSES_PER_TICK`. */
const ANCHOR_CAPACITY = 256;

/** Scheduled-but-not-yet-sounded note-ons tracked so `stop()` can silence
 *  them at their onset instead of letting the look-ahead window ring on. */
const PENDING_CAPACITY = 1024;

/** Notes scheduled on but not yet off, so the loop brace can cut them. */
const SOUNDING_CAPACITY = 512;

/**
 * The transport, plus the two things the frozen `Transport` interface does not
 * expose: entering the recording state (SS12 "record = playing + capture
 * flag") and the clock drop counter.
 */
export interface EngineTransport extends Transport {
  /** Enters `recording` — playing plus the capture flag. Arms capture without
   *  restarting playback when already playing. */
  record(fromTick?: Ticks): void;
  /** Worker ticks that never arrived. Diagnostics only: scheduling is
   *  time-based, so a dropped tick costs look-ahead margin, not events. */
  readonly droppedTicks: number;
  /** Which clock implementation is driving this transport (SS12). `"worker"`
   *  is the only one the shipped app should ever report: `"timer"` means
   *  `createDefaultClock` degraded to a main-thread `setInterval`, which
   *  browsers throttle to >= 1 s in background tabs — the exact failure SS12
   *  put the clock in a Worker to avoid. Exposed so that degradation is
   *  observable from outside the engine (e2e/interaction/transport.spec.ts
   *  asserts on it against a real browser). */
  readonly clockKind: ClockKind;
}

/** `TransportDeps` plus the seam headless tests and the offline renderer use
 *  to supply their own clock. Not part of the frozen contract. */
export interface EngineTransportDeps extends TransportDeps {
  clock?: Clock | undefined;
}

/** Reads the mutable `state` without narrowing it for the rest of a block —
 *  re-entrant listeners can change it under any function call. */
function stateIsStopped(current: TransportState): boolean {
  return current === "stopped";
}

/** A loop brace only counts if it is enabled and spans at least one tick. */
function loopIsActive(loop: LoopRegion | null): loop is LoopRegion {
  return loop !== null && loop.enabled && loop.end > loop.start;
}

/** Copies a brace with its bounds normalized to integer ticks (SS8: a tick is
 *  ALWAYS an integer). The brace ends up in `tempoMap.secondsAt`, in the
 *  anchor ring and in `cursorTick`, all of which assume integrality — the
 *  same defensive rounding `play()`/`seek()` already do for their entry tick. */
function normalizeLoop(next: LoopRegion | null): LoopRegion | null {
  if (next === null) return null;
  return { ...next, start: Math.round(next.start), end: Math.round(next.end) };
}

export function createEngineTransport(
  deps: EngineTransportDeps,
): EngineTransport {
  const ctx = deps.context;
  const events = deps.events;
  const resolveTarget = deps.resolveTarget;
  const tickIntervalMs =
    deps.tickIntervalMs !== undefined && deps.tickIntervalMs > 0
      ? deps.tickIntervalMs
      : DEFAULT_TICK_INTERVAL_MS;
  const requestedLookAhead =
    deps.lookAheadSeconds !== undefined && deps.lookAheadSeconds > 0
      ? deps.lookAheadSeconds
      : DEFAULT_LOOKAHEAD_SECONDS;
  // SS12's two-clock design only works while the look-ahead window is longer
  // than the tick period: each tick schedules from `now + START_LEAD` out to
  // `now + lookAhead`, so with a shorter window every tick would schedule
  // less than the music that just elapsed, the cursor would fall behind the
  // audio clock, and the re-anchor branch in `onTick` would discard the
  // difference — playback silently drags slower than real time instead of
  // failing. Raise it to a floor rather than trusting the caller.
  const lookAhead = Math.max(
    requestedLookAhead,
    tickIntervalMs / 1000 + START_LEAD_SECONDS * 2,
  );
  const clock = deps.clock ?? createDefaultClock();
  const ownsClock = deps.clock === undefined;

  let tempoMap = deps.tempoMap;
  let loop: LoopRegion | null =
    deps.loop === undefined ? null : normalizeLoop(deps.loop);
  let state: TransportState = "stopped";

  /** Where `play()` started; `stop()` parks the playhead back here. */
  let parkedTick = 0;
  /** Song tick scheduled up to (exclusive) and its audio-clock time. */
  let cursorTick = 0;
  let cursorTime = 0;
  /**
   * Bumped every time the cursor is (re)placed by `restartCursor` — i.e. by
   * `play`, `seek` and `setTempoMap`. All three can be called RE-ENTRANTLY
   * from caller code the scheduling loop invokes (`resolveTarget`, a
   * `NoteTarget` method, a `WindowFiller`), and the code that resumes
   * afterwards would otherwise write the pre-call cursor back over the new
   * one. Comparing the counter is how a caller notices it was overtaken.
   */
  let cursorEpoch = 0;

  // --- playback passes, for mapping currentTime back to a song tick --------
  // A "pass" is a stretch of linear playback; the loop brace ends one and
  // starts the next. Parallel typed arrays, used as a ring, so `positionTicks`
  // (called at rAF) and the tick path never allocate.
  const anchorTime = new Float64Array(ANCHOR_CAPACITY);
  const anchorTick = new Float64Array(ANCHOR_CAPACITY);
  const anchorSongSeconds = new Float64Array(ANCHOR_CAPACITY);
  const anchorEndTick = new Float64Array(ANCHOR_CAPACITY);
  let anchorHead = 0; // index of the oldest live anchor
  let anchorCount = 0;

  function anchorIndex(i: number): number {
    return (anchorHead + i) % ANCHOR_CAPACITY;
  }

  function clearAnchors(): void {
    anchorHead = 0;
    anchorCount = 0;
  }

  function pushAnchor(time: Seconds, tick: Ticks): void {
    if (anchorCount === ANCHOR_CAPACITY) {
      // Defensive: `anchorFor` retires finished passes on every tick and at
      // most MAX_PASSES_PER_TICK passes are pushed between two of those, so
      // with the capacities above the ring cannot actually fill. If it ever
      // did, dropping the oldest pass is the safe outcome — the cost is that
      // `positionTicks()` clamps for stale times.
      anchorHead = (anchorHead + 1) % ANCHOR_CAPACITY;
      anchorCount--;
    }
    const i = anchorIndex(anchorCount);
    anchorTime[i] = time;
    anchorTick[i] = tick;
    anchorSongSeconds[i] = tempoMap.secondsAt(tick);
    anchorEndTick[i] = Infinity;
    anchorCount++;
  }

  function closeLastAnchor(endTick: Ticks): void {
    if (anchorCount === 0) return;
    anchorEndTick[anchorIndex(anchorCount - 1)] = endTick;
  }

  /** Index of the pass containing audio time `now`, or -1 if there is none. */
  function anchorFor(now: Seconds): number {
    if (anchorCount === 0) return -1;
    // Retire passes that finished before `now`, keeping the current one.
    while (anchorCount > 1 && anchorTime[anchorIndex(1)]! <= now) {
      anchorHead = (anchorHead + 1) % ANCHOR_CAPACITY;
      anchorCount--;
    }
    return anchorIndex(0);
  }

  // --- scheduled note-ons still in the future ------------------------------
  const pendingTime = new Float64Array(PENDING_CAPACITY);
  const pendingPitch = new Int32Array(PENDING_CAPACITY);
  const pendingTrack: ChannelId[] = new Array<ChannelId>(PENDING_CAPACITY).fill(
    "",
  );
  let pendingCount = 0;
  /** True when a note-on had to be dropped from the ring; `stop()` then falls
   *  back to a second `allNotesOff` past the horizon. */
  let pendingOverflowed = false;

  function rememberPending(
    time: Seconds,
    pitch: number,
    trackId: ChannelId,
  ): void {
    if (pendingCount === PENDING_CAPACITY) {
      pendingOverflowed = true;
      return;
    }
    pendingTime[pendingCount] = time;
    pendingPitch[pendingCount] = pitch;
    pendingTrack[pendingCount] = trackId;
    pendingCount++;
  }

  function prunePending(now: Seconds): void {
    let write = 0;
    for (let i = 0; i < pendingCount; i++) {
      if (pendingTime[i]! <= now) continue;
      if (write !== i) {
        pendingTime[write] = pendingTime[i]!;
        pendingPitch[write] = pendingPitch[i]!;
        pendingTrack[write] = pendingTrack[i]!;
      }
      write++;
    }
    pendingCount = write;
  }

  // --- notes scheduled on whose note-off has not been scheduled yet --------
  // `NoteEventSource.eventsInRange` is half-open and playback never reaches
  // the ticks past the brace, so a note held across the transport loop brace
  // would never receive its note-off and would sustain forever. The clip-loop
  // unroller cuts notes at every repetition boundary (clipEventSource.ts);
  // this is the same cut for the brace, which is "the transport's job".
  const soundingPitch = new Int32Array(SOUNDING_CAPACITY);
  const soundingTrack: ChannelId[] = new Array<ChannelId>(
    SOUNDING_CAPACITY,
  ).fill("");
  let soundingCount = 0;
  /** True when the ring overflowed; the brace then falls back to allNotesOff. */
  let soundingOverflowed = false;

  // One entry per scheduled note OCCURRENCE, deliberately not deduplicated by
  // (pitch, track): two notes of the same pitch on one track may overlap
  // (nothing in `MidiClip` forbids it, and M1's piano roll lets a user draw
  // it). Collapsing them would let the first note-off clear the ledger while
  // the second note is still held, and the brace would then find nothing to
  // release — exactly the stuck note this bookkeeping exists to prevent.
  function markSounding(pitch: number, trackId: ChannelId): void {
    if (soundingCount === SOUNDING_CAPACITY) {
      soundingOverflowed = true;
      return;
    }
    soundingPitch[soundingCount] = pitch;
    soundingTrack[soundingCount] = trackId;
    soundingCount++;
  }

  /** Drops ONE entry for this (pitch, track) — a note-off releases the note
   *  that was marked, not every same-pitch note still held. */
  function clearSounding(pitch: number, trackId: ChannelId): void {
    for (let i = 0; i < soundingCount; i++) {
      if (soundingPitch[i] !== pitch || soundingTrack[i] !== trackId) continue;
      const last = soundingCount - 1;
      soundingPitch[i] = soundingPitch[last]!;
      soundingTrack[i] = soundingTrack[last]!;
      soundingCount--;
      return;
    }
  }

  /** Releases every still-held note at `when` (the loop brace). */
  function cutSounding(when: Seconds): void {
    for (let i = 0; i < soundingCount; i++) {
      targetFor(soundingTrack[i]!)?.noteOff(soundingPitch[i]!, when);
    }
    soundingCount = 0;
    if (soundingOverflowed) {
      for (let i = 0; i < seenTracks.length; i++) {
        resolveTarget(seenTracks[i]!)?.allNotesOff(when);
      }
      soundingOverflowed = false;
    }
  }

  // --- targets seen while playing, for allNotesOff -------------------------
  const seenTracks: ChannelId[] = [];

  function noteTrack(trackId: ChannelId): void {
    for (let i = 0; i < seenTracks.length; i++) {
      if (seenTracks[i] === trackId) return;
    }
    seenTracks.push(trackId);
  }

  // --- subscribers ---------------------------------------------------------
  const fillers: WindowFiller[] = [];
  const stateListeners: ((s: TransportState) => void)[] = [];

  function setState(next: TransportState): void {
    if (state === next) return;
    state = next;
    for (let i = 0; i < stateListeners.length; i++) stateListeners[i]!(next);
  }

  // --- scheduling ----------------------------------------------------------
  // Cached target lookup: consecutive events usually share a track, and
  // `resolveTarget` is caller-supplied.
  let cachedTrack: ChannelId | null = null;
  let cachedTarget: NoteTarget | undefined;

  function targetFor(trackId: ChannelId): NoteTarget | undefined {
    if (cachedTrack !== trackId) {
      cachedTrack = trackId;
      cachedTarget = resolveTarget(trackId);
    }
    return cachedTarget;
  }

  /**
   * Tells the event source that the next window does not continue the last
   * one, so it can suppress the note-offs of notes whose note-on it never
   * emitted. Every caller here has just released what it had scheduled (a
   * `panic`, or the `cutSounding` beside the call), so those note-offs would
   * be unpaired — and on an instrument that voices overlapping same-pitch
   * notes separately (`VoiceAllocator`, SS7) an unpaired note-off cuts a
   * LIVE voice short. The source cannot infer this itself: a seek can land
   * exactly on the previous window's end tick, and the stall re-anchor below
   * breaks time while leaving the tick stream contiguous.
   */
  function markDiscontinuity(): void {
    events.onDiscontinuity?.();
  }

  /**
   * Schedules one linear window `[fromTick, toTick)` whose start is at
   * `fromTime` on the audio clock, and returns the audio time of its end.
   */
  function scheduleWindow(
    fromTick: Ticks,
    toTick: Ticks,
    fromTime: Seconds,
  ): Seconds {
    const songSecondsAtFrom = tempoMap.secondsAt(fromTick);
    const endTime =
      fromTime + (tempoMap.secondsAt(toTick) - songSecondsAtFrom);

    for (const ev of events.eventsInRange(fromTick, toTick)) {
      // Read every field before advancing the iterator: the source is allowed
      // to hand back the same mutable object each time (SS12 allocation
      // contract), so nothing here may retain `ev`.
      const trackId = ev.trackId;
      const pitch = ev.pitch;
      const vel = ev.vel;
      const when =
        fromTime + (tempoMap.secondsAt(ev.tick) - songSecondsAtFrom);
      const isOn = ev.type === "noteOn";
      const target = targetFor(trackId);
      if (target === undefined) continue;
      noteTrack(trackId);
      if (isOn) {
        target.noteOn(pitch, vel, when);
        rememberPending(when, pitch, trackId);
        markSounding(pitch, trackId);
      } else {
        target.noteOff(pitch, when);
        clearSounding(pitch, trackId);
      }
    }

    // SS11's automation sampler attaches here (`fillWindow(horizon)`), so the
    // transport never grows a dependency on it.
    for (let i = 0; i < fillers.length; i++) {
      fillers[i]!.fillWindow(endTime, fromTick, toTick);
    }
    return endTime;
  }

  /** One worker tick: extend scheduling out to `currentTime + lookAhead`. */
  function onTick(): void {
    if (state === "stopped") return;
    const now = ctx.currentTime;
    prunePending(now);
    anchorFor(now);
    // The instrument behind a track can be swapped between ticks (SS7), so
    // the per-event target cache lives for one tick only.
    cachedTrack = null;
    cachedTarget = undefined;

    // A main-thread stall longer than the look-ahead leaves the cursor BEHIND
    // the audio clock. Scheduling that backlog would hand the instrument a
    // burst of already-past timestamps, which `sampleOffsetForBlock` clamps
    // into one render quantum — a chord where a sequence was meant (SS12:
    // jitter in the tick loop must never reach the audio). Re-anchor instead:
    // playback continues from where it was, late by the stall, and every
    // event keeps a future `when`.
    if (cursorTime < now) {
      closeLastAnchor(cursorTick);
      cursorTime = now + START_LEAD_SECONDS;
      // The re-anchor is a discontinuity in TIME the way the brace is one in
      // ticks, so it needs the same cut: a note already handed to the
      // instrument keeps sounding until its note-off, and that note-off is now
      // late by the whole stall — an unbounded drone (SS12: jitter in the tick
      // loop must never reach the audio). Releasing what is held here costs a
      // shortened note instead — and the source is told, so it drops the
      // note-offs this cut has just answered. (Emitting them anyway is not the
      // harmless no-op it looks like: the tick stream is CONTIGUOUS across a
      // re-anchor, so the same-pitch note that started after the stall is
      // still live when the stale note-off arrives, and the instrument would
      // release that one instead.)
      cutSounding(cursorTime);
      markDiscontinuity();
      pushAnchor(cursorTime, cursorTick);
    }

    const horizon = now + lookAhead;
    let passes = 0;
    while (cursorTime < horizon && passes < MAX_PASSES_PER_TICK) {
      passes++;
      const songSecondsAtCursor = tempoMap.secondsAt(cursorTick);
      let windowEnd = tempoMap.ticksAt(
        songSecondsAtCursor + (horizon - cursorTime),
      );
      let wraps = false;
      // `>=`, not `>`: `ticksAt` rounds, so a window boundary landing exactly
      // on `loop.end` is an ordinary outcome. Treating it as "no wrap" would
      // park the cursor ON the brace, where the `cursorTick < loop.end` guard
      // is false forever after — the brace would silently disappear.
      if (loopIsActive(loop) && cursorTick < loop.end && windowEnd >= loop.end) {
        windowEnd = loop.end;
        wraps = true;
      }
      if (windowEnd <= cursorTick) break; // sub-tick remainder; next tick continues

      const epoch = cursorEpoch;
      const endTime = scheduleWindow(cursorTick, windowEnd, cursorTime);
      // `scheduleWindow` calls out to caller code — `resolveTarget`, and every
      // registered `WindowFiller` (SS11's automation sampler) — and that code
      // is allowed to stop or seek the transport. `stop()` has already sent
      // its panic by now, so scheduling another window would post note-ons
      // BEHIND it, for up to a whole look-ahead, while `state` reads
      // "stopped". `beginPlayback` guards the same re-entrancy after
      // `setState`; this is the scheduling-loop half of it.
      //
      // `seek()` / `setTempoMap()` / a re-entrant `play()` are the same hazard
      // with a quieter failure: each one re-places the cursor (and already
      // scheduled its own first window from there), so writing `cursorTime` /
      // `cursorTick` below would restore the PRE-seek position and play the
      // material the seek jumped over, while `positionTicks()` — which reads
      // the anchor ring the seek reset — follows the seek. Bail and let the
      // next tick continue from the new cursor.
      if (stateIsStopped(state) || cursorEpoch !== epoch) return;
      cursorTime = endTime;
      if (wraps && loopIsActive(loop)) {
        // Cut whatever is still held at the brace before jumping back, so a
        // note spanning it is re-triggered rather than left sustaining, and
        // tell the source so it does not also emit their note-offs.
        cutSounding(endTime);
        markDiscontinuity();
        closeLastAnchor(loop.end);
        cursorTick = loop.start;
        pushAnchor(endTime, loop.start);
      } else {
        cursorTick = windowEnd;
      }
    }
  }

  // --- transitions ---------------------------------------------------------
  /**
   * Silences everything already handed to an instrument. `final` says nothing
   * will be scheduled behind this panic (`stop()`), which is what licenses the
   * belt-and-braces second `allNotesOff` past the horizon below.
   */
  function panic(now: Seconds, final: boolean): void {
    const at = now + STOP_EPSILON_SECONDS;
    for (let i = 0; i < pendingCount; i++) {
      if (pendingTime[i]! < at) continue;
      // The note-on is already scheduled and cannot be retracted; release it
      // at its own onset so it never becomes an audible straggler.
      const target = resolveTarget(pendingTrack[i]!);
      target?.noteOff(pendingPitch[i]!, pendingTime[i]! + STOP_EPSILON_SECONDS);
    }
    pendingCount = 0;
    soundingCount = 0;
    soundingOverflowed = false;
    // SS12 says "down every track"; `seenTracks` is every track this playback
    // pass actually scheduled a note on, which is the same set as long as the
    // scheduler is the only thing that can put a note into an instrument —
    // true for M0. `TransportDeps.resolveTarget` is a lookup with no way to
    // enumerate channels, so widening this to "every channel that exists"
    // needs the contract to grow an enumerator; that belongs with the first
    // non-scheduler note source (SS12's count-in click, MIDI-input capture).
    for (let i = 0; i < seenTracks.length; i++) {
      const target = resolveTarget(seenTracks[i]!);
      target?.allNotesOff(at);
      // The ring overflowed, so `pendingCount` above did not cover every
      // note-on already scheduled; a second sweep past the horizon catches the
      // stragglers. Only when nothing follows: `seek()` and `setTempoMap()`
      // re-anchor and schedule a fresh window immediately, and this late panic
      // would land ~a look-ahead INTO that new playback and kill it.
      if (final && pendingOverflowed) target?.allNotesOff(at + lookAhead);
    }
    pendingOverflowed = false;
    cachedTrack = null;
    cachedTarget = undefined;
  }

  /** (Re)starts the look-ahead cursor at `tick`, effective ~immediately. */
  function restartCursor(tick: Ticks): void {
    cursorEpoch++;
    cursorTick = tick;
    cursorTime = ctx.currentTime + START_LEAD_SECONDS;
    clearAnchors();
    // Every caller has just panicked (or is starting a fresh pass), so the
    // next window opens with nothing held — even when it happens to open on
    // the tick the last one ended at.
    markDiscontinuity();
    pushAnchor(cursorTime, tick);
  }

  function beginPlayback(tick: Ticks, next: TransportState): void {
    parkedTick = tick;
    seenTracks.length = 0;
    pendingCount = 0;
    pendingOverflowed = false;
    soundingCount = 0;
    soundingOverflowed = false;
    restartCursor(tick);
    setState(next);
    // `setState` notifies listeners synchronously, and a listener is allowed
    // to stop (or re-seek) the transport. Bail rather than starting a clock
    // that nothing will ever stop.
    if (stateIsStopped(state)) return;
    onTick(); // fill the first window now rather than one clock period late
    if (stateIsStopped(state)) return;
    clock.start(tickIntervalMs);
  }

  const unsubClock = clock.onTick(onTick);

  const transport: EngineTransport = {
    get state(): TransportState {
      return state;
    },
    get tempoMap() {
      return tempoMap;
    },
    get droppedTicks(): number {
      return clock.droppedTicks;
    },
    get clockKind(): ClockKind {
      return clock.kind;
    },

    positionTicks(): Ticks {
      if (state === "stopped") return parkedTick;
      const i = anchorFor(ctx.currentTime);
      if (i < 0) return parkedTick;
      const start = anchorTick[i]!;
      const elapsed = ctx.currentTime - anchorTime[i]!;
      if (elapsed <= 0) return start;
      const tick = tempoMap.ticksAt(anchorSongSeconds[i]! + elapsed);
      const end = anchorEndTick[i]!;
      if (tick < start) return start;
      if (tick > end) return end;
      return tick;
    },

    positionSeconds(): Seconds {
      if (state === "stopped") return tempoMap.secondsAt(parkedTick);
      const i = anchorFor(ctx.currentTime);
      if (i < 0) return tempoMap.secondsAt(parkedTick);
      const elapsed = ctx.currentTime - anchorTime[i]!;
      const songSeconds = anchorSongSeconds[i]! + (elapsed > 0 ? elapsed : 0);
      const end = anchorEndTick[i]!;
      if (Number.isFinite(end)) {
        const endSeconds = tempoMap.secondsAt(end);
        if (songSeconds > endSeconds) return endSeconds;
      }
      return songSeconds;
    },

    play(fromTick?: Ticks): void {
      if (state !== "stopped") {
        if (fromTick !== undefined) transport.seek(fromTick);
        return;
      }
      beginPlayback(fromTick === undefined ? parkedTick : Math.round(fromTick), "playing");
    },

    record(fromTick?: Ticks): void {
      if (state !== "stopped") {
        if (fromTick !== undefined) transport.seek(fromTick);
        setState("recording");
        return;
      }
      beginPlayback(
        fromTick === undefined ? parkedTick : Math.round(fromTick),
        "recording",
      );
    },

    stop(): void {
      if (state === "stopped") return;
      const epoch = cursorEpoch;
      panic(ctx.currentTime, true);
      // `panic` calls out to caller code (`resolveTarget`, `NoteTarget`
      // methods), and that code is allowed to re-enter the transport — the
      // same re-entrancy `beginPlayback` and the scheduling loop already
      // guard. A re-entrant `play()`/`seek()` re-places the cursor and
      // schedules a whole window of note-ons BEHIND the panic that is still
      // running, so stopping means silencing those too. Stop still wins: the
      // teardown below then runs over the restarted pass rather than leaving
      // half of it live (a clock ticking at 25 ms while `state` reads
      // "stopped" — which is why `clock.stop()` is here and not before the
      // panic, where a re-entrant `beginPlayback` would restart it).
      if (cursorEpoch !== epoch) panic(ctx.currentTime, true);
      clock.stop();
      clearAnchors();
      // Invariant (SS12): the playhead parks at the point playback started.
      setState("stopped");
    },

    seek(tick: Ticks): void {
      const target = Math.round(tick);
      if (state === "stopped") {
        parkedTick = target;
        return;
      }
      panic(ctx.currentTime, false);
      parkedTick = target;
      seenTracks.length = 0;
      restartCursor(target);
      onTick();
    },

    notesChanged(): void {
      // Same re-anchor as `seek`, at the position we are already at: panic
      // releases everything sounding AND every note-on already scheduled into
      // the look-ahead (those would otherwise fire after the swap and find
      // their note-off suppressed as an orphan), and `restartCursor` marks the
      // discontinuity and schedules the new material from here.
      if (state === "stopped") return;
      const at = transport.positionTicks();
      panic(ctx.currentTime, false);
      seenTracks.length = 0;
      restartCursor(at);
      onTick();
    },

    setTempoMap(map): void {
      if (state === "stopped") {
        tempoMap = map;
        return;
      }
      const at = transport.positionTicks();
      panic(ctx.currentTime, false);
      tempoMap = map;
      seenTracks.length = 0;
      restartCursor(at);
      onTick();
    },

    setLoop(next: LoopRegion | null): void {
      loop = normalizeLoop(next);
    },

    addWindowFiller(filler: WindowFiller): Unsub {
      fillers.push(filler);
      return () => {
        const i = fillers.indexOf(filler);
        if (i >= 0) fillers.splice(i, 1);
      };
    },

    onStateChange(cb: (s: TransportState) => void): Unsub {
      stateListeners.push(cb);
      return () => {
        const i = stateListeners.indexOf(cb);
        if (i >= 0) stateListeners.splice(i, 1);
      };
    },

    dispose(): void {
      transport.stop();
      unsubClock();
      if (ownsClock) clock.dispose();
      else clock.stop();
      fillers.length = 0;
      stateListeners.length = 0;
    },
  };

  return transport;
}

/** The SS12 factory, exactly as `CreateTransport` declares it. */
export const createTransport: CreateTransport = (deps: TransportDeps) =>
  createEngineTransport(deps);
