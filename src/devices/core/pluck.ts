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
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  env: GainNode;
  releasedAt: number | null;
}

const ATTACK_S = 0.003;
const RELEASE_S = 0.06;

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

    const voices = new Map<number, Voice>();

    const releaseVoice = (pitch: number, voice: Voice, when: number): void => {
      if (voice.releasedAt !== null) return;
      voice.releasedAt = when;
      voice.env.gain.cancelScheduledValues(when);
      voice.env.gain.setTargetAtTime(0, when, RELEASE_S / 3);
      voice.osc.stop(when + RELEASE_S * 4);
      void pitch;
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
        // Same pitch retriggers: choke the old voice first.
        const existing = voices.get(pitch);
        if (existing !== undefined) releaseVoice(pitch, existing, at);

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
        const voice: Voice = { osc, filter, env, releasedAt: null };
        voices.set(pitch, voice);
        osc.onended = () => {
          osc.disconnect();
          filter.disconnect();
          env.disconnect();
          if (voices.get(pitch) === voice) voices.delete(pitch);
        };
        osc.start(at);
        // A pluck ends itself: stop well past audibility.
        osc.stop(at + decayS * 6 + RELEASE_S);
      },

      noteOff: (pitch, when) => {
        const voice = voices.get(pitch);
        if (voice !== undefined) releaseVoice(pitch, voice, Math.max(when, ctx.currentTime));
      },

      allNotesOff: (when) => {
        const at = Math.max(when, ctx.currentTime);
        for (const [pitch, voice] of voices) releaseVoice(pitch, voice, at);
      },

      dispose: (when?: Seconds): void => {
        for (const [pitch, voice] of voices) releaseVoice(pitch, voice, when ?? ctx.currentTime);
        rampOutAndDisconnect(when, [outGain], { context: ctx });
      },
    });
  },
};
