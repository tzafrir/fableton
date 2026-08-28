// The NOTE chain: a channel's `midiChain` (SS7 `midiEffect` devices) wired
// between the scheduler and the track's instrument.
//
// WHERE THIS SITS. The transport resolves a track to one `NoteTarget` and
// pushes note-ons at exact audio-clock seconds; the instrument's
// `DeviceInstance` is normally that target. A note effect is a device that
// takes the same three methods and forwards a REWRITTEN stream, so a chain of
// them is just a linked list ending at the instrument — the transport, the
// piano-roll audition and the computer-keyboard player all keep talking to
// one `NoteTarget` and none of them learns that anything changed.
//
// WHY THERE IS A PUMP. An arpeggiator is the one device that has to emit
// notes at moments nothing announces: a held chord produces sixteen notes
// from one note-on. So a note effect also gets told how far ahead the
// scheduler has reached, once per look-ahead window, AFTER that window's
// incoming events have been delivered (see `NoteWindow`). That is the same
// `WindowFiller` seam SS11's automation sampler uses, which is why the
// transport needs no new concept for any of this.
//
// AND WHY THERE IS A SECOND, FREE-RUNNING PUMP. Half of what an arpeggiator
// is for happens with the transport STOPPED: hold a chord on the keyboard and
// hear it run. There is no look-ahead window then, so the shell pumps one at
// rAF off `ctx.currentTime` — the same window shape over a tick line that
// starts wherever the free run started. Ticks are still ticks (the effect's
// rate is in beats either way); they are simply not song position, which no
// note effect is allowed to see anyway.

import type {
  ChannelId,
  DeviceInstance,
  NoteTarget,
  NoteWindow,
  Seconds,
  TempoMap,
  Ticks,
} from "../../types";

/** Free-run look-ahead. Shorter than the transport's 200 ms: nothing is
 *  being read off a clip, so the only cost of a short horizon is how far
 *  ahead a rate change lands, and a long one is latency on a held chord. */
export const FREE_LOOKAHEAD_SECONDS = 0.08;

/** A free-run pump that has been away longer than this has been stalled (a
 *  backgrounded tab); it re-anchors instead of scheduling the backlog. */
const FREE_STALL_SECONDS = 0.5;

/** Notes go nowhere until the engine says where. */
const NULL_TARGET: NoteTarget = {
  noteOn: () => undefined,
  noteOff: () => undefined,
  allNotesOff: () => undefined,
};

/** One channel's assembled note path. */
export interface ChannelNoteChain {
  readonly channelId: ChannelId;
  /** What the transport and the audition call — the first device in the
   *  chain that accepts notes, or the instrument when the chain is empty. */
  readonly head: NoteTarget;
  /** The note effects, in chain order. Pumped in that order, so an effect
   *  always sees what the one before it has just generated. */
  readonly effects: readonly DeviceInstance[];
}

/** A `DeviceInstance` as a `NoteTarget`, or `undefined` if it takes no notes.
 *  Only `noteOn` is required, for the same reason the instrument path only
 *  requires it: a device with no note-off to honour is still playable. */
export function noteTargetOfInstance(instance: DeviceInstance): NoteTarget | undefined {
  const { noteOn, noteOff, allNotesOff } = instance;
  if (noteOn === undefined) return undefined;
  return {
    noteOn: (pitch, vel, when) => noteOn.call(instance, pitch, vel, when),
    noteOff: (pitch, when) => (noteOff ?? (() => undefined)).call(instance, pitch, when),
    allNotesOff: (when) => (allNotesOff ?? (() => undefined)).call(instance, when),
  };
}

/**
 * Wires `effects` in front of `instrument` and returns the chain.
 *
 * Built back to front, so each device is told its output before anything can
 * reach it. A device that implements no `noteOn` is still given an output
 * (it may be a pure generator) but does not become the head — notes route
 * past it rather than into a method it does not have.
 */
export function buildNoteChain(
  channelId: ChannelId,
  effects: readonly DeviceInstance[],
  instrument: NoteTarget,
): ChannelNoteChain {
  let next = instrument;
  for (let i = effects.length - 1; i >= 0; i--) {
    const effect = effects[i]!;
    effect.setNoteOutput?.(next);
    next = noteTargetOfInstance(effect) ?? next;
  }
  return { channelId, head: next, effects };
}

export interface NoteChainRunnerDeps {
  ctx: BaseAudioContext;
  /** Read per window: the map is swapped whenever the document's tempo is. */
  tempoMap: () => TempoMap;
}

/**
 * Pumps every channel's note effects — once per transport window while
 * playing, and free-running off the wall clock while stopped.
 *
 * One runner for the whole engine rather than one `WindowFiller` per channel:
 * the set of chains is rebuilt on every apply, and re-registering N fillers
 * against the transport on every document edit would be a subscription churn
 * where a single loop over an array does.
 */
export interface NoteChainRunner {
  /** Replaces the chain set (after every apply). */
  setChains(chains: readonly ChannelNoteChain[]): void;
  /** True while any channel has a note effect at all — the shell uses it to
   *  decide whether the free-run rAF is worth running. */
  hasEffects(): boolean;
  /** The transport's `WindowFiller` half. */
  fillWindow(horizonSeconds: Seconds, fromTick: Ticks, toTick: Ticks): void;
  /** The stopped-transport half; call at rAF. No-op while playing. */
  pumpFree(): void;
  /** Playing suspends the free run: the transport's own windows take over,
   *  on song position rather than a free tick line. */
  setPlaying(playing: boolean): void;
  /** Releases everything every chain is holding, at `when`. */
  releaseAll(when: Seconds): void;
}

export function createNoteChainRunner(deps: NoteChainRunnerDeps): NoteChainRunner {
  const { ctx } = deps;
  let chains: readonly ChannelNoteChain[] = [];
  let effectCount = 0;
  let playing = false;

  // --- the reused window (SS12: no allocation in a per-tick path) ---------
  // Both pumps describe their window as a linear map from ticks to audio
  // seconds — `anchorTick` sounds at `anchorTime`, and a tick is
  // `secondsPerTick` long. That is exact for the free run (one tempo) and,
  // for the transport, exact within a window: the transport itself computes
  // event times as `fromTime + (secondsAt(tick) - secondsAt(fromTick))`, so
  // the tempo map is consulted directly there instead of the linear rate.
  let useMap = false;
  let anchorTick = 0;
  let anchorTime = 0;
  let secondsPerTick = 0;

  const window: {
    fromTick: Ticks;
    toTick: Ticks;
    ppq: number;
    timeAt(tick: Ticks): Seconds;
  } = {
    fromTick: 0,
    toTick: 0,
    ppq: 960,
    timeAt(tick: Ticks): Seconds {
      if (!useMap) return anchorTime + (tick - anchorTick) * secondsPerTick;
      const map = deps.tempoMap();
      return anchorTime + map.secondsBetween(anchorTick, tick);
    },
  };

  function pumpAll(): void {
    for (let c = 0; c < chains.length; c++) {
      const effects = chains[c]!.effects;
      for (let i = 0; i < effects.length; i++) {
        effects[i]!.fillNotes?.(window as NoteWindow);
      }
    }
  }

  // --- free run ------------------------------------------------------------
  /** `null` until the first free pump after a stop (or a stall). */
  let freeTick: Ticks | null = null;
  let freeTime = 0;

  function resetFree(): void {
    freeTick = null;
  }

  return {
    setChains(next: readonly ChannelNoteChain[]): void {
      chains = next;
      let count = 0;
      for (const chain of next) count += chain.effects.length;
      effectCount = count;
    },

    hasEffects(): boolean {
      return effectCount > 0;
    },

    fillWindow(horizonSeconds: Seconds, fromTick: Ticks, toTick: Ticks): void {
      if (effectCount === 0) return;
      const map = deps.tempoMap();
      useMap = true;
      // The transport hands over the time of the window's END; every other
      // moment in it is that, minus the song-time distance back to the tick.
      anchorTick = toTick;
      anchorTime = horizonSeconds;
      secondsPerTick = 0;
      window.fromTick = fromTick;
      window.toTick = toTick;
      window.ppq = map.ppq;
      pumpAll();
      // A window arriving while stopped (the transport is allowed to schedule
      // one before its state flips) must not leave the free run continuing
      // from a stale anchor.
      resetFree();
    },

    pumpFree(): void {
      if (playing || effectCount === 0) return;
      const now = ctx.currentTime;
      const map = deps.tempoMap();
      const spb = 60 / Math.max(1, map.bpmAt(0));
      const perTick = spb / map.ppq;
      if (freeTick === null || freeTime < now - FREE_STALL_SECONDS) {
        // Anchor slightly ahead: every note this pump emits must still carry
        // a future timestamp when it reaches the instrument.
        freeTick = 0;
        freeTime = now + FREE_LOOKAHEAD_SECONDS / 2;
      }
      if (freeTime < now) freeTime = now;
      const horizon = now + FREE_LOOKAHEAD_SECONDS;
      if (horizon <= freeTime) return;
      const span = Math.round((horizon - freeTime) / perTick);
      if (span <= 0) return;
      const toTick = freeTick + span;

      useMap = false;
      anchorTick = freeTick;
      anchorTime = freeTime;
      secondsPerTick = perTick;
      window.fromTick = freeTick;
      window.toTick = toTick;
      window.ppq = map.ppq;
      pumpAll();

      // Re-derive the new anchor from the tick line rather than from
      // `horizon`, so rounding `span` cannot make the two drift apart.
      freeTime = freeTime + span * perTick;
      freeTick = toTick;
    },

    setPlaying(next: boolean): void {
      if (playing === next) return;
      playing = next;
      resetFree();
    },

    releaseAll(when: Seconds): void {
      for (const chain of chains) chain.head.allNotesOff(when);
      resetFree();
    },
  };
}

export { NULL_TARGET as NULL_NOTE_TARGET };
