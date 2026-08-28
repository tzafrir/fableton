// `core.arpeggiator` — the first `midiEffect`: held chords in, a stream of
// single notes out, on the way to the track's instrument.
//
// It is the LIVE counterpart to `src/state/arpeggio.ts`, which rewrites the
// notes in a clip. Both exist on purpose: the transform gives you notes you
// can see and nudge, this gives you a chord you can hold — over a progression
// in the arrangement, or on the keyboard with nothing playing at all. They
// walk their chords in the same order (src/music/arpeggio.ts).
//
// HOW IT KEEPS TIME. Incoming notes arrive with a timestamp that is usually
// in the FUTURE — the scheduler runs a look-ahead window — so "which notes
// are held" is not a set, it is a timeline. Every note-on and note-off is
// filed as a pending event, and each step of the grid applies the events that
// have come due at that step's own moment before deciding what to play. That
// is what makes a chord change land exactly on the step it was written on
// rather than a window early or late.
//
// THE GRID is the song's: step `i` sits at `i * stepTicks`, so an arp is in
// time with everything else without needing to see the song position. With
// the transport stopped the shell pumps a free-running tick line instead
// (see `NoteChainRunner`), which is the same arithmetic over a different
// origin.

import type {
  DeviceDefinition,
  DeviceInstance,
  NoteTarget,
  NoteWindow,
  Seconds,
} from "../../types";
import { p } from "../../params/descriptors";
import { ARP_MODES, arpOrder } from "../../music/arpeggio";
import { deviceInstance } from "../harness/deviceInstance";
import {
  NOTE_DIVISION_LABELS,
  divisionBeats,
  divisionIndex,
} from "./noteDivisions";

/** Mode labels, in `ARP_MODES` order plus the one only a LIVE arp can offer:
 *  `Chord` plays the whole chord on every step, which is a strummer/gate
 *  rather than an arpeggio and has no meaning as a note-rewriting transform. */
export const ARP_MODE_LABELS = ["Up", "Down", "Up/Down", "Down/Up", "As Played", "Random", "Chord"];

/** Index of `Chord` — the one mode with no `ARP_MODES` entry behind it. */
const CHORD_MODE = ARP_MODES.length;

/** Voices one step may emit at once (`Chord` mode over four octaves). */
const MAX_STEP_VOICES = 32;

/** Emitted notes remembered for `allNotesOff`. A step emits at most
 *  `MAX_STEP_VOICES`, and a look-ahead window holds a few dozen steps. */
const EMITTED_CAPACITY = 512;

/** Shortest note the gate is allowed to produce. */
const MIN_GATE_SECONDS = 0.01;

/** How far past a panic a straggler note-on is released, so it never becomes
 *  audible. Matches the transport's own stop epsilon. */
const PANIC_EPSILON = 0.005;

/**
 * Deterministic randomness for `Random` mode.
 *
 * `Math.random` would make an offline export differ from itself run twice,
 * which is the one property SS12's "the export is the same engine" is worth
 * having. An LCG seeded per instance gives a stream that is arbitrary but
 * reproducible — the same choice `core.noise` makes for its buffers.
 */
function makeRandom(): () => number {
  let state = 0x2f6e2b1 >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** One incoming note event, filed until the step it comes due at. */
interface PendingEvent {
  when: Seconds;
  pitch: number;
  vel: number;
  on: boolean;
}

/** A key the arp considers held, with the order it arrived in (`As Played`). */
interface HeldKey {
  pitch: number;
  vel: number;
  seq: number;
}

/**
 * The tick of step `i` under `swing`.
 *
 * Swing delays every SECOND step by a fraction of the step, which is the
 * definition every DAW uses: at +50% the off-beat sits three-quarters of the
 * way through the pair (a triplet shuffle), at 0 the grid is straight, and
 * negative values rush it.
 */
export function stepTick(index: number, stepTicks: number, swingPercent: number): number {
  const base = index * stepTicks;
  if (index % 2 === 0) return base;
  return base + (swingPercent / 100) * stepTicks;
}

export const Arpeggiator: DeviceDefinition = {
  id: "core.arpeggiator",
  version: 1,
  kind: "midiEffect",
  label: "Arpeggiator",
  // A note effect is not in the audio graph at all (SS6): no ports, no edges.
  audioIn: [],
  audioOut: [],
  params: [
    p.enum("rate", "Rate", {
      labels: [...NOTE_DIVISION_LABELS],
      default: divisionIndex("1/16"),
    }),
    p.enum("mode", "Mode", { labels: [...ARP_MODE_LABELS], default: 0 }),
    p.stepped("octaves", "Octaves", { min: 1, max: 4, default: 1, step: 1 }),
    // Over 100% the notes overlap, which is what makes a legato arp on a
    // polyphonic instrument; the low end is a staccato tick.
    p.pct("gate", "Gate", { min: 5, max: 200, default: 80 }),
    p.pct("swing", "Swing", { min: -50, max: 50, default: 0, bipolar: true }),
    p.st("transpose", "Transpose", { min: -24, max: 24, default: 0 }),
    p.pct("velocity", "Velocity", { min: 10, max: 200, default: 100 }),
    // Latch: the chord keeps running after the keys come up, until the next
    // chord replaces it. The one control that makes a live arp usable with
    // two hands free.
    p.toggle("hold", "Hold", { default: false }),
    p.toggle("retrigger", "Retrigger", { default: true }),
  ],
  panel: {
    rows: [
      {
        label: "Pattern",
        controls: [
          { paramId: "rate" },
          { paramId: "mode" },
          { paramId: "octaves" },
          { paramId: "transpose" },
        ],
      },
      {
        label: "Feel",
        controls: [
          { paramId: "gate" },
          { paramId: "swing" },
          { paramId: "velocity" },
        ],
      },
      { label: "Keys", controls: [{ paramId: "hold" }, { paramId: "retrigger" }] },
    ],
  },

  create(): DeviceInstance {
    let out: NoteTarget | null = null;

    // --- params, as plain values read at generation time -------------------
    let rate = divisionIndex("1/16");
    let mode = 0;
    let octaves = 1;
    let gate = 80;
    let swing = 0;
    let transpose = 0;
    let velocity = 100;
    let hold = 0;
    let retrigger = 1;

    // --- incoming, on a timeline ------------------------------------------
    const pending: PendingEvent[] = [];
    /** Keys physically down, in arrival order. */
    const keys: HeldKey[] = [];
    /** The latched chord, while `hold` is on. */
    const latched: HeldKey[] = [];
    let seq = 0;
    /** Where the pattern is. Runs across chord changes — that is what makes
     *  an arp hold its place over a progression (the same rule the transform
     *  applies with its `orderIndex`). */
    let patternPos = 0;
    /** Last step index actually generated, so a window that overlaps the
     *  previous one cannot emit a step twice. */
    let lastStep = -Infinity;
    /** Tick the previous window ended at, so a window that does not continue
     *  it — a transport loop wrap, a seek, the start of a free run — can be
     *  recognised. Without it the step ledger above, which only ever moves
     *  forward, would silence the arp for good the first time the playhead
     *  jumped backwards. */
    let lastToTick: number | null = null;

    // --- emitted, for the panic path ---------------------------------------
    const emittedPitch = new Int32Array(EMITTED_CAPACITY);
    const emittedOn = new Float64Array(EMITTED_CAPACITY);
    const emittedOff = new Float64Array(EMITTED_CAPACITY);
    let emittedCount = 0;

    const random = makeRandom();
    /** Scratch reused by every step (SS12: no allocation per note). */
    const voicePitch = new Int32Array(MAX_STEP_VOICES);
    const voiceVel = new Int32Array(MAX_STEP_VOICES);

    function remember(pitch: number, onTime: Seconds, offTime: Seconds): void {
      if (emittedCount === EMITTED_CAPACITY) {
        // Drop the oldest rather than the newest: the oldest is the one most
        // likely to have finished already.
        emittedPitch.copyWithin(0, 1);
        emittedOn.copyWithin(0, 1);
        emittedOff.copyWithin(0, 1);
        emittedCount--;
      }
      emittedPitch[emittedCount] = pitch;
      emittedOn[emittedCount] = onTime;
      emittedOff[emittedCount] = offTime;
      emittedCount++;
    }

    function forgetBefore(time: Seconds): void {
      let write = 0;
      for (let i = 0; i < emittedCount; i++) {
        if (emittedOff[i]! < time) continue;
        emittedPitch[write] = emittedPitch[i]!;
        emittedOn[write] = emittedOn[i]!;
        emittedOff[write] = emittedOff[i]!;
        write++;
      }
      emittedCount = write;
    }

    /** The chord the arp is currently playing. */
    function chord(): HeldKey[] {
      return hold >= 0.5 ? latched : keys;
    }

    function indexOfKey(list: HeldKey[], pitch: number): number {
      for (let i = 0; i < list.length; i++) if (list[i]!.pitch === pitch) return i;
      return -1;
    }

    /** Applies every pending event at or before `time`. */
    function advanceTo(time: Seconds): void {
      while (pending.length > 0 && pending[0]!.when <= time) {
        const event = pending.shift()!;
        if (event.on) {
          // A new chord starts when nothing is down: with `hold` on that
          // replaces the latched chord rather than adding to it, which is
          // what makes latch usable (otherwise every chord accumulates).
          if (keys.length === 0) {
            if (hold >= 0.5) latched.length = 0;
            if (retrigger >= 0.5) patternPos = 0;
          }
          if (indexOfKey(keys, event.pitch) < 0) {
            keys.push({ pitch: event.pitch, vel: event.vel, seq: seq++ });
          }
          if (hold >= 0.5 && indexOfKey(latched, event.pitch) < 0) {
            latched.push({ pitch: event.pitch, vel: event.vel, seq: seq++ });
          }
          continue;
        }
        const at = indexOfKey(keys, event.pitch);
        if (at >= 0) keys.splice(at, 1);
        // A note-off does NOT clear the latch: that is the whole point of it.
        if (hold < 0.5) {
          const held = indexOfKey(latched, event.pitch);
          if (held >= 0) latched.splice(held, 1);
        }
      }
    }

    /** Fills the voice scratch with the chord expanded over `octaves`, in the
     *  order the mode wants, and returns how many there are. */
    function buildVoices(): number {
      const source = chord();
      if (source.length === 0) return 0;
      const sorted = [...source];
      if (mode === ARP_MODES.indexOf("asPlayed")) sorted.sort((a, b) => a.seq - b.seq);
      else sorted.sort((a, b) => a.pitch - b.pitch);
      let count = 0;
      const reach = Math.max(1, Math.min(4, Math.round(octaves)));
      for (let octave = 0; octave < reach; octave++) {
        for (const key of sorted) {
          if (count === MAX_STEP_VOICES) return count;
          voicePitch[count] = key.pitch + 12 * octave;
          voiceVel[count] = key.vel;
          count++;
        }
      }
      return count;
    }

    function emit(pitch: number, vel: number, at: Seconds, until: Seconds): void {
      const target = out;
      if (target === null) return;
      const played = Math.round(pitch + transpose);
      if (played < 0 || played > 127) return;
      const level = Math.max(1, Math.min(127, Math.round((vel * velocity) / 100)));
      target.noteOn(played, level, at);
      target.noteOff(played, until);
      remember(played, at, until);
    }

    function fillNotes(window: NoteWindow): void {
      if (out === null) return;
      if (lastToTick !== window.fromTick) lastStep = -Infinity;
      lastToTick = window.toTick;
      const stepTicks = Math.max(1, divisionBeats(rate) * window.ppq);
      // Swing moves a step by at most half of one, so the pair either side of
      // the window's own bounds has to be considered too.
      const first = Math.floor(window.fromTick / stepTicks) - 1;
      const last = Math.ceil(window.toTick / stepTicks) + 1;
      const modeIndex = Math.round(mode);

      for (let i = first; i <= last; i++) {
        const tick = stepTick(i, stepTicks, swing);
        if (tick < window.fromTick || tick >= window.toTick) continue;
        if (i <= lastStep) continue;
        lastStep = i;

        const at = window.timeAt(tick);
        advanceTo(at);
        const voices = buildVoices();
        if (voices === 0) continue;

        // The gate is a fraction of the step, measured in the same musical
        // time the step is — so it follows a tempo change without conversion.
        const stepSeconds = Math.max(
          MIN_GATE_SECONDS,
          window.timeAt(tick + stepTicks) - at,
        );
        const until = at + Math.max(MIN_GATE_SECONDS, (stepSeconds * gate) / 100);

        if (modeIndex === CHORD_MODE) {
          for (let v = 0; v < voices; v++) emit(voicePitch[v]!, voiceVel[v]!, at, until);
          patternPos++;
          continue;
        }

        const modeName = ARP_MODES[Math.min(ARP_MODES.length - 1, Math.max(0, modeIndex))]!;
        const order = arpOrder(voices, modeName);
        if (order.length === 0) continue;
        const pick =
          modeName === "random"
            ? Math.min(voices - 1, Math.floor(random() * voices))
            : (order[patternPos % order.length] ?? 0);
        patternPos++;
        emit(voicePitch[pick]!, voiceVel[pick]!, at, until);
      }
      forgetBefore(window.timeAt(window.fromTick));
    }

    return deviceInstance({
      messageParams: {
        rate: (v) => {
          rate = v;
        },
        mode: (v) => {
          mode = v;
        },
        octaves: (v) => {
          octaves = v;
        },
        gate: (v) => {
          gate = v;
        },
        swing: (v) => {
          swing = v;
        },
        transpose: (v) => {
          transpose = v;
        },
        velocity: (v) => {
          velocity = v;
        },
        hold: (v) => {
          const wasHeld = hold >= 0.5;
          hold = v;
          // Turning latch OFF hands the chord back to the keys that are
          // actually down, which is usually none of them — the arp stops,
          // which is what the user just asked for.
          if (wasHeld && v < 0.5) latched.length = 0;
          if (!wasHeld && v >= 0.5) {
            latched.length = 0;
            for (const key of keys) latched.push({ ...key });
          }
        },
        retrigger: (v) => {
          retrigger = v;
        },
      },

      noteOn: (pitch, vel, when) => {
        pending.push({ when, pitch, vel, on: true });
        pending.sort((a, b) => a.when - b.when);
      },
      noteOff: (pitch, when) => {
        pending.push({ when, pitch, vel: 0, on: false });
        pending.sort((a, b) => a.when - b.when);
      },
      allNotesOff: (when) => {
        pending.length = 0;
        keys.length = 0;
        latched.length = 0;
        lastStep = -Infinity;
        lastToTick = null;
        patternPos = 0;
        const target = out;
        if (target === null) return;
        // A note-on already handed downstream cannot be retracted, so release
        // it at its own onset instead — otherwise a panic during a look-ahead
        // window leaves up to a window of arpeggio still to sound. (The same
        // trick, for the same reason, as the transport's own `panic`.)
        for (let i = 0; i < emittedCount; i++) {
          if (emittedOn[i]! >= when) target.noteOff(emittedPitch[i]!, emittedOn[i]! + PANIC_EPSILON);
        }
        emittedCount = 0;
        target.allNotesOff(when);
      },

      setNoteOutput: (target) => {
        out = target;
      },
      fillNotes,

      dispose: (): void => {
        pending.length = 0;
        keys.length = 0;
        latched.length = 0;
        emittedCount = 0;
        out = null;
      },
    });
  },
};
