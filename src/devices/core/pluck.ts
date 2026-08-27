// `core.pluck` — the SS18-M4 "second instrument", built the OTHER way SS14
// describes: "an `AudioWorkletProcessor` (or node-per-voice graph for simple
// synths)". This one is node-per-voice: each note is an OscillatorNode ->
// lowpass -> envelope gain, with the filter sweeping down from `brightness`
// for the pluck character. Voices free themselves on `onended`, so there is
// no allocator to leak; `allNotesOff` force-releases everything sounding.
//
// It exists to prove the swap path (SS7): same clips, a different engine
// underneath, params carried where local ids match (`gain` matches the
// poly synth's).
//
// Voice bookkeeping is a LIST, not a map keyed by pitch: two overlapping
// notes on one pitch are two voices, and a note-off must release the voice
// ITS OWN note-on created (see `noteOff`). Polyphony is capped and stolen
// oldest-first, the same LRU rule `./polySynth/voiceAllocator.ts` applies to
// the worklet synth, so ordinary note density cannot pile up unbounded
// against the SS2 audio budget.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { dbToGain, deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

export const PLUCK_SHAPES = ["triangle", "square", "sawtooth"] as const;
export type PluckShape = (typeof PLUCK_SHAPES)[number];

export function pluckShapeFromIndex(index: number): PluckShape {
  const clamped = Math.min(PLUCK_SHAPES.length - 1, Math.max(0, Math.round(index)));
  return PLUCK_SHAPES[clamped] ?? "triangle";
}

export function midiToHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

interface Voice {
  pitch: number;
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  env: GainNode;
  /** When a release/choke/steal was scheduled; null while still ringing. */
  releasedAt: number | null;
  /** A note-off has already claimed this voice (note-on/note-off pairing). */
  matched: boolean;
  /** The oscillator reached its stop time and disconnected itself. */
  ended: boolean;
}

const ATTACK_S = 0.003;
const RELEASE_S = 0.06;
/** A stolen voice gets a much shorter fade than a released one: it has to be
 *  gone before the note that stole it needs the headroom, and ~20 ms is the
 *  SS7 crossfade the rest of the engine already treats as click-free. */
const STEAL_S = 0.02;
/**
 * How many decay time-constants of oscillator to actually render. The decay
 * envelope is `setTargetAtTime(0, ..., decayS / 4)`, so `2 * decayS` is eight
 * tau — about -70 dB, past audibility. (It used to run `6 * decayS` = 24 tau,
 * i.e. ~3.4x longer than the voice can be heard: pure wasted render.)
 */
const DECAY_TAILS = 2;
/** SS2 budget ("~40 concurrent voices+effects" for a whole project), spent on
 *  one instrument. Above this the oldest ringing voice is stolen. */
export const MAX_VOICES = 24;
/** Ceiling on finished-but-unmatched voices kept only for note-off pairing —
 *  a runaway source of note-ons without note-offs cannot grow the list. */
const MAX_TRACKED = 128;

export const Pluck: DeviceDefinition = {
  id: "core.pluck",
  version: 1,
  kind: "instrument",
  label: "Pluck",
  audioIn: [],
  audioOut: [{ id: "out" }],
  params: [
    p.enum("shape", "Shape", { labels: [...PLUCK_SHAPES] }),
    p.ms("decay", "Decay", { min: 40, max: 4000, default: 350 }),
    p.hz("brightness", "Brightness", { min: 400, max: 16000, default: 5000 }),
    p.db("gain", "Gain", { min: -60, max: 6, default: 0 }),
  ],

  create(ctx, io): DeviceInstance {
    const outGain = ctx.createGain();
    outGain.connect(io.out);

    // Live values the next noteOn reads — plucks are configured at pluck
    // time; changing them mid-ring alters the NEXT note (that IS the
    // instrument's character, documented over faked per-voice rebinding).
    let shape: PluckShape = "triangle";
    let decayS = 0.35;
    let brightnessHz = 5000;

    /** Voices in note-on order, oldest first. */
    const voices: Voice[] = [];

    const forget = (voice: Voice): void => {
      const index = voices.indexOf(voice);
      if (index >= 0) voices.splice(index, 1);
    };

    /** Fades a voice out over `fadeS` and stops its oscillator after it. */
    const fadeOut = (voice: Voice, when: number, fadeS: number): void => {
      if (voice.releasedAt !== null || voice.ended) return;
      voice.releasedAt = when;
      voice.env.gain.cancelScheduledValues(when);
      voice.env.gain.setTargetAtTime(0, when, fadeS / 3);
      voice.osc.stop(when + fadeS * 4);
    };

    const releaseVoice = (voice: Voice, when: number): void => fadeOut(voice, when, RELEASE_S);

    /** Drops finished voices nobody can pair a note-off with any more —
     *  oldest tombstone first, so the pairing that survives is the recent one. */
    const prune = (): void => {
      if (voices.length <= MAX_TRACKED) return;
      for (let i = 0; i < voices.length && voices.length > MAX_TRACKED; ) {
        if (voices[i]?.ended === true) voices.splice(i, 1);
        else i++;
      }
    };

    return deviceInstance({
      gainParams: { gain: outGain },
      connectParam: (localId, handle) => {
        if (localId === "shape") handle.bindMessage((v) => void (shape = pluckShapeFromIndex(v)));
        else if (localId === "decay") handle.bindMessage((v) => void (decayS = v / 1000));
        else if (localId === "brightness") handle.bindMessage((v) => void (brightnessHz = v));
      },

      noteOn: (pitch, vel, when) => {
        const at = Math.max(when, ctx.currentTime);
        // Same pitch retriggers: choke the ringing voice first — a plucked
        // string damps when it is plucked again. The choked voice STAYS in the
        // list until its own note-off claims it, so that note-off cannot fall
        // through onto the voice that just replaced it.
        for (const voice of voices) {
          if (voice.pitch === pitch && voice.releasedAt === null) releaseVoice(voice, at);
        }

        // SS2 audio budget: cap polyphony, stealing the oldest voice still
        // ringing (LRU, as `VoiceAllocator` does). Voices already in their
        // fade do not count — they stop themselves within tens of ms.
        let ringing = 0;
        for (const voice of voices) {
          if (voice.releasedAt === null && !voice.ended) ringing++;
        }
        for (let i = 0; i < voices.length && ringing >= MAX_VOICES; i++) {
          const victim = voices[i];
          if (victim === undefined || victim.releasedAt !== null || victim.ended) continue;
          fadeOut(victim, at, STEAL_S);
          ringing--;
        }
        prune();

        const osc = ctx.createOscillator();
        osc.type = shape;
        osc.frequency.value = midiToHz(pitch);
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.Q.value = 1.2;
        // The pluck: bright at the attack, sweeping down over the decay.
        filter.frequency.setValueAtTime(brightnessHz, at);
        filter.frequency.exponentialRampToValueAtTime(
          Math.max(80, midiToHz(pitch)),
          at + Math.max(0.01, decayS),
        );
        const env = ctx.createGain();
        const peak = dbToGain(-12) * (vel / 127);
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(peak, at + ATTACK_S);
        env.gain.setTargetAtTime(0, at + ATTACK_S, decayS / 4);

        osc.connect(filter);
        filter.connect(env);
        env.connect(outGain);
        const voice: Voice = {
          pitch,
          osc,
          filter,
          env,
          releasedAt: null,
          matched: false,
          ended: false,
        };
        voices.push(voice);
        osc.onended = () => {
          voice.ended = true;
          osc.disconnect();
          filter.disconnect();
          env.disconnect();
          // Kept as a tombstone until its note-off arrives, so pairing below
          // stays correct for a note held far longer than it rings.
          if (voice.matched) forget(voice);
        };
        osc.start(at);
        // A pluck ends itself: stop just past audibility (see DECAY_TAILS).
        osc.stop(at + decayS * DECAY_TAILS + RELEASE_S);
      },

      noteOff: (pitch, when) => {
        const at = Math.max(when, ctx.currentTime);
        // Pair a note-off with the note-on that made the voice, oldest first —
        // the same FIFO rule as `VoiceAllocator.release`. Releasing "whichever
        // voice currently holds this pitch" would let the first of two
        // overlapping same-pitch notes cut the second one short at its own
        // note-off (A: 0..960, B: 480..1440 — B died at 960).
        for (const voice of voices) {
          if (voice.pitch !== pitch || voice.matched) continue;
          voice.matched = true;
          releaseVoice(voice, at);
          if (voice.ended) forget(voice);
          return;
        }
      },

      allNotesOff: (when) => {
        const at = Math.max(when, ctx.currentTime);
        // Every pending note-off is answered at once: nothing is left to pair.
        for (const voice of [...voices]) {
          voice.matched = true;
          releaseVoice(voice, at);
          if (voice.ended) forget(voice);
        }
      },

      dispose: (when?: Seconds): void => {
        const at = when ?? ctx.currentTime;
        for (const voice of voices) releaseVoice(voice, at);
        voices.length = 0;
        rampOutAndDisconnect(when, [outGain], { context: ctx });
      },
    });
  },
};
