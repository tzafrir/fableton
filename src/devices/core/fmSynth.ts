// `core.fm` — two-operator FM, node-per-voice (SS14: "an AudioWorkletProcessor
// or node-per-voice graph for simple synths"). Two operators is the smallest
// arrangement that is recognisably FM rather than a filtered oscillator, and
// it maps cleanly onto WebAudio primitives: the modulator is an oscillator
// whose output is a gain-scaled signal wired into the carrier's `frequency`
// AudioParam, which is what "frequency modulation" literally means here.
//
//   modOsc -> modGain -> carrier.frequency
//   carrier -> env -> out
//
// The two things that make it musical rather than a demo:
//
//  * `ratio` is a RATIO, not a frequency. The modulator runs at
//    `carrierHz * ratio`, so the timbre is the same on every key — integer
//    ratios give harmonic (bell/organ/brass) spectra, fractional ones give
//    inharmonic (metallic) ones. A fixed modulator frequency would make one
//    note sound right and every other note wrong.
//  * `index` is scaled by the CARRIER frequency (`modGain = index *
//    carrierHz`). FM's modulation index is deviation over modulator
//    frequency; keeping it proportional is what stops high notes turning to
//    noise and low notes going dull.
//
// The index envelope (`index` -> `indexEnd` over `indexDecay`) is where FM
// gets its attack character: a bright bell strike that settles into a
// simpler tone is an index envelope, not a filter.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { dbToGain, deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

export function midiToHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

/** SS2 audio budget, spent on one instrument (the pluck's ceiling). */
export const MAX_VOICES = 16;
/** Cap on finished-but-unmatched voices kept only for note-off pairing. */
const MAX_TRACKED = 128;
const STEAL_S = 0.02;

interface Voice {
  pitch: number;
  carrier: OscillatorNode;
  modulator: OscillatorNode;
  modGain: GainNode;
  env: GainNode;
  releasedAt: number | null;
  matched: boolean;
  ended: boolean;
}

export const FmSynth: DeviceDefinition = {
  id: "core.fm",
  version: 1,
  kind: "instrument",
  label: "FM Synth",
  audioIn: [],
  audioOut: [{ id: "out" }],
  params: [
    // 0.5..12 in quarter steps: the musically useful ratios (1, 2, 3, 1.5,
    // 3.5 ...) without a continuous sweep that mostly lands between them.
    p.stepped("ratio", "Ratio", { min: 0.25, max: 12, step: 0.25, default: 2 }),
    p.continuous("index", "Index", { min: 0, max: 24, default: 4 }),
    p.continuous("indexEnd", "Index End", { min: 0, max: 24, default: 0.5 }),
    p.ms("indexDecay", "Index Decay", { min: 5, max: 4000, default: 350 }),
    p.ms("attack", "Attack", { min: 0, max: 2000, default: 4 }),
    p.ms("decay", "Decay", { min: 5, max: 6000, default: 600 }),
    p.pct("sustain", "Sustain", { default: 40 }),
    p.ms("release", "Release", { min: 5, max: 6000, default: 260 }),
    p.db("gain", "Gain", { min: -60, max: 6, default: -6 }),
  ],

  create(ctx, io): DeviceInstance {
    const outGain = ctx.createGain();
    outGain.connect(io.out);

    // Live values the NEXT note-on reads. Mid-note changes shape the next
    // note, the same contract `core.pluck` documents — per-voice rebinding
    // would mean re-creating the whole voice graph on every knob move.
    let ratio = 2;
    let index = 4;
    let indexEnd = 0.5;
    let indexDecayS = 0.35;
    let attackS = 0.004;
    let decayS = 0.6;
    let sustain = 0.4;
    let releaseS = 0.26;

    const voices: Voice[] = [];

    const forget = (voice: Voice): void => {
      const i = voices.indexOf(voice);
      if (i >= 0) voices.splice(i, 1);
    };

    const fadeOut = (voice: Voice, when: number, fadeS: number): void => {
      if (voice.releasedAt !== null || voice.ended) return;
      voice.releasedAt = when;
      voice.env.gain.cancelScheduledValues(when);
      voice.env.gain.setTargetAtTime(0, when, Math.max(0.001, fadeS) / 3);
      const stopAt = when + Math.max(0.01, fadeS) * 4;
      voice.carrier.stop(stopAt);
      voice.modulator.stop(stopAt);
    };

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
        if (localId === "ratio") handle.bindMessage((v) => void (ratio = Math.max(0.01, v)));
        else if (localId === "index") handle.bindMessage((v) => void (index = v));
        else if (localId === "indexEnd") handle.bindMessage((v) => void (indexEnd = v));
        else if (localId === "indexDecay") handle.bindMessage((v) => void (indexDecayS = v / 1000));
        else if (localId === "attack") handle.bindMessage((v) => void (attackS = v / 1000));
        else if (localId === "decay") handle.bindMessage((v) => void (decayS = v / 1000));
        else if (localId === "sustain") handle.bindMessage((v) => void (sustain = v / 100));
        else if (localId === "release") handle.bindMessage((v) => void (releaseS = v / 1000));
      },

      noteOn: (pitch, vel, when) => {
        const at = Math.max(when, ctx.currentTime);

        // Retrigger on the same pitch releases the ringing voice, and the
        // choked voice stays listed until ITS note-off claims it.
        for (const voice of voices) {
          if (voice.pitch === pitch && voice.releasedAt === null) fadeOut(voice, at, releaseS);
        }
        let ringing = 0;
        for (const voice of voices) if (voice.releasedAt === null && !voice.ended) ringing++;
        for (let i = 0; i < voices.length && ringing >= MAX_VOICES; i++) {
          const victim = voices[i];
          if (victim === undefined || victim.releasedAt !== null || victim.ended) continue;
          fadeOut(victim, at, STEAL_S);
          ringing--;
        }
        prune();

        const hz = midiToHz(pitch);
        const carrier = ctx.createOscillator();
        carrier.type = "sine";
        carrier.frequency.value = hz;

        const modulator = ctx.createOscillator();
        modulator.type = "sine";
        modulator.frequency.value = hz * ratio;

        // Deviation in Hz = index * carrier frequency (see the file header).
        const modGain = ctx.createGain();
        modGain.gain.setValueAtTime(index * hz, at);
        modGain.gain.setTargetAtTime(indexEnd * hz, at, Math.max(0.001, indexDecayS) / 3);
        modulator.connect(modGain);
        modGain.connect(carrier.frequency);

        const env = ctx.createGain();
        const peak = dbToGain(-6) * (vel / 127);
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(peak, at + Math.max(0.0005, attackS));
        env.gain.setTargetAtTime(
          peak * sustain,
          at + Math.max(0.0005, attackS),
          Math.max(0.001, decayS) / 3,
        );

        carrier.connect(env);
        env.connect(outGain);

        const voice: Voice = {
          pitch,
          carrier,
          modulator,
          modGain,
          env,
          releasedAt: null,
          matched: false,
          ended: false,
        };
        voices.push(voice);
        carrier.onended = () => {
          voice.ended = true;
          carrier.disconnect();
          modulator.disconnect();
          modGain.disconnect();
          env.disconnect();
          if (voice.matched) forget(voice);
        };
        carrier.start(at);
        modulator.start(at);
      },

      noteOff: (pitch, when) => {
        const at = Math.max(when, ctx.currentTime);
        // Release the OLDEST unmatched voice on this pitch: overlapping notes
        // on one pitch are separate voices, and each note-off must claim the
        // voice its own note-on created.
        for (const voice of voices) {
          if (voice.pitch !== pitch || voice.matched) continue;
          voice.matched = true;
          if (voice.ended) forget(voice);
          else fadeOut(voice, at, releaseS);
          return;
        }
      },

      allNotesOff: (when) => {
        const at = Math.max(when ?? 0, ctx.currentTime);
        for (const voice of [...voices]) {
          voice.matched = true;
          fadeOut(voice, at, STEAL_S);
        }
      },

      dispose: (when?: Seconds): void => {
        for (const voice of [...voices]) {
          fadeOut(voice, Math.max(when ?? 0, ctx.currentTime), STEAL_S);
        }
        rampOutAndDisconnect(when, [outGain], { context: ctx });
      },
    });
  },
};
