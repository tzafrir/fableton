// `core.noise` — a playable noise source.
//
// Noise is the raw material for a whole family of sounds a synth cannot make
// — wind, surf, risers and sweeps, hi-hats, snare tops, the breath under a
// pad — and every one of them is the same three things: pick a COLOUR, shape
// it with a FILTER, and put an ENVELOPE on it. So that is the instrument.
//
// It is playable from the keyboard even though noise has no pitch: the note
// moves the filter, scaled by `keyTrack`. At 100% the cutoff tracks the
// keyboard exactly (an octave up per octave up), which turns the device into
// a tuned band of noise you can write melodies with; at 0% every note sounds
// identical and the roll is just a rhythm grid. Both are useful, so it is a
// knob rather than a decision made here.
//
// Built the node-per-voice way (SS14: "an `AudioWorkletProcessor` (or
// node-per-voice graph for simple synths)"), same shape as ./pluck.ts: a
// looping buffer source -> filter -> envelope gain per note, LRU voice
// stealing against the SS2 budget, and note-off paired FIFO against the
// note-on that made the voice.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { dbToGain, deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

export const NOISE_COLORS = ["white", "pink", "brown"] as const;
export type NoiseColor = (typeof NOISE_COLORS)[number];

export const NOISE_FILTER_TYPES = ["lowpass", "bandpass", "highpass"] as const;
export type NoiseFilterType = (typeof NOISE_FILTER_TYPES)[number];

export function noiseColorFromIndex(index: number): NoiseColor {
  const clamped = Math.min(NOISE_COLORS.length - 1, Math.max(0, Math.round(index)));
  return NOISE_COLORS[clamped] ?? "white";
}

export function noiseFilterFromIndex(index: number): NoiseFilterType {
  const clamped = Math.min(NOISE_FILTER_TYPES.length - 1, Math.max(0, Math.round(index)));
  return NOISE_FILTER_TYPES[clamped] ?? "lowpass";
}

/** The pitch `keyTrack` is measured from: at 100% tracking, a note here puts
 *  the filter exactly on `cutoff`. C3, the middle of the roll's default view. */
export const KEY_TRACK_CENTER_PITCH = 60;

/**
 * Cutoff for one note, in Hz.
 *
 * `keyTrack` is a FRACTION of true key tracking: at 1 the cutoff doubles per
 * octave above `KEY_TRACK_CENTER_PITCH` (so playing the keyboard transposes
 * the noise band exactly), at 0 it does not move at all. Exported because it
 * is the whole musical claim of this device and deserves its own test.
 */
export function trackedCutoffHz(cutoffHz: number, pitch: number, keyTrack: number): number {
  const octaves = ((pitch - KEY_TRACK_CENTER_PITCH) / 12) * keyTrack;
  return Math.min(20000, Math.max(20, cutoffHz * 2 ** octaves));
}

/** Seconds of noise generated per colour. Long enough that the loop point is
 *  not a rhythm of its own (a 1-second loop of noise ticks audibly under a
 *  long pad), short enough to stay a cheap one-off allocation. */
const NOISE_SECONDS = 4;

const buffers = new WeakMap<BaseAudioContext, Partial<Record<NoiseColor, AudioBuffer>>>();

/**
 * One `NOISE_SECONDS` buffer per (context, colour), made on demand and shared
 * by every voice.
 *
 * The white source is a plain LCG, not `Math.random()`, for the same reason
 * `drumVoices.noiseBuffer` uses one: an offline render (SS16's export) must be
 * bit-identical to the last one, and a device that reseeds itself from the
 * global RNG makes that impossible.
 *
 *   white — flat spectrum, the raw LCG output.
 *   pink  — -3 dB/octave, via Paul Kellet's economical filter bank. The
 *           classic "natural" noise: surf, rain, breath.
 *   brown — -6 dB/octave, a leaky integrator over white. Deep rumble; scaled
 *           back because integration piles energy into the low end.
 */
export function noiseBufferOf(ctx: BaseAudioContext, color: NoiseColor): AudioBuffer {
  const perContext = buffers.get(ctx) ?? {};
  const cached = perContext[color];
  if (cached !== undefined) return cached;

  const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x2f6e2b1 >>> 0;
  const white = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  if (color === "white") {
    for (let i = 0; i < length; i++) data[i] = white();
  } else if (color === "pink") {
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      const w = white();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < length; i++) {
      const w = white();
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
  }

  perContext[color] = buffer;
  buffers.set(ctx, perContext);
  return buffer;
}

interface Voice {
  pitch: number;
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  env: GainNode;
  /** When the release was scheduled; null while the key is still down. */
  releasedAt: number | null;
  /** A note-off has already claimed this voice (note-on/note-off pairing). */
  matched: boolean;
  ended: boolean;
}

/** As `pluck.ts`: a stolen voice gets a much shorter fade than a released one. */
const STEAL_S = 0.02;
/** SS2 audio budget, one instrument's share. Noise voices are cheap (one
 *  buffer read + one biquad), so this sits a little above the pluck's. */
export const MAX_VOICES = 32;
const MAX_TRACKED = 128;

export const Noise: DeviceDefinition = {
  id: "core.noise",
  version: 1,
  kind: "instrument",
  label: "Noise",
  audioIn: [],
  audioOut: [{ id: "out" }],
  params: [
    p.enum("color", "Color", { labels: [...NOISE_COLORS] }),
    p.enum("filterType", "Filter", { labels: [...NOISE_FILTER_TYPES] }),
    p.hz("cutoff", "Cutoff", { min: 40, max: 18000, default: 4000 }),
    p.continuous("resonance", "Resonance", { min: 0.5, max: 20, default: 1 }),
    p.pct("keyTrack", "Key Track", { default: 0 }),
    p.ms("attack", "Attack", { min: 1, max: 4000, default: 4 }),
    p.ms("decay", "Decay", { min: 1, max: 4000, default: 200 }),
    p.pct("sustain", "Sustain", { default: 60 }),
    p.ms("release", "Release", { min: 1, max: 6000, default: 300 }),
    p.db("gain", "Gain", { min: -60, max: 6, default: -6 }),
  ],
  panel: {
    rows: [
      { label: "Source", controls: [{ paramId: "color" }, { paramId: "gain" }] },
      {
        label: "Filter",
        controls: [
          { paramId: "filterType" },
          { paramId: "cutoff" },
          { paramId: "resonance" },
          { paramId: "keyTrack" },
        ],
      },
      {
        label: "Envelope",
        controls: [
          { paramId: "attack" },
          { paramId: "decay" },
          { paramId: "sustain" },
          { paramId: "release" },
        ],
      },
    ],
  },

  create(ctx, io): DeviceInstance {
    const outGain = ctx.createGain();
    outGain.connect(io.out);

    let color: NoiseColor = "white";
    let filterType: NoiseFilterType = "lowpass";
    let cutoffHz = 4000;
    let resonance = 1;
    let keyTrack = 0;
    let attackS = 0.004;
    let decayS = 0.2;
    let sustain = 0.6;
    let releaseS = 0.3;

    const voices: Voice[] = [];

    const forget = (voice: Voice): void => {
      const index = voices.indexOf(voice);
      if (index >= 0) voices.splice(index, 1);
    };

    const fadeOut = (voice: Voice, when: number, fadeS: number): void => {
      if (voice.releasedAt !== null || voice.ended) return;
      voice.releasedAt = when;
      voice.env.gain.cancelScheduledValues(when);
      // From wherever the envelope actually is, not from the peak: a note
      // released during its attack must not jump up first.
      voice.env.gain.setValueAtTime(voice.env.gain.value, when);
      voice.env.gain.setTargetAtTime(0, when, fadeS / 3);
      voice.src.stop(when + fadeS * 4);
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
        if (localId === "color") handle.bindMessage((v) => void (color = noiseColorFromIndex(v)));
        else if (localId === "filterType") {
          handle.bindMessage((v) => void (filterType = noiseFilterFromIndex(v)));
        } else if (localId === "cutoff") handle.bindMessage((v) => void (cutoffHz = v));
        else if (localId === "resonance") handle.bindMessage((v) => void (resonance = v));
        else if (localId === "keyTrack") handle.bindMessage((v) => void (keyTrack = v / 100));
        else if (localId === "attack") handle.bindMessage((v) => void (attackS = v / 1000));
        else if (localId === "decay") handle.bindMessage((v) => void (decayS = v / 1000));
        else if (localId === "sustain") handle.bindMessage((v) => void (sustain = v / 100));
        else if (localId === "release") handle.bindMessage((v) => void (releaseS = v / 1000));
      },

      noteOn: (pitch, vel, when) => {
        const at = Math.max(when, ctx.currentTime);

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

        const src = ctx.createBufferSource();
        src.buffer = noiseBufferOf(ctx, color);
        src.loop = true;
        // Each voice enters the buffer somewhere else, so two notes played
        // together are two different noises rather than one twice as loud.
        src.loopStart = 0;
        src.loopEnd = src.buffer.duration;

        const filter = ctx.createBiquadFilter();
        filter.type = filterType;
        filter.frequency.value = trackedCutoffHz(cutoffHz, pitch, keyTrack);
        filter.Q.value = resonance;

        const env = ctx.createGain();
        const peak = dbToGain(-6) * (vel / 127);
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(peak, at + attackS);
        // Decay toward the sustain floor, then hold there until note-off.
        env.gain.setTargetAtTime(peak * sustain, at + attackS, Math.max(0.001, decayS / 4));

        src.connect(filter);
        filter.connect(env);
        env.connect(outGain);

        const voice: Voice = {
          pitch,
          src,
          filter,
          env,
          releasedAt: null,
          matched: false,
          ended: false,
        };
        voices.push(voice);
        src.onended = () => {
          voice.ended = true;
          src.disconnect();
          filter.disconnect();
          env.disconnect();
          if (voice.matched) forget(voice);
        };
        // A looping source never ends by itself — every voice is stopped by
        // its note-off, a steal, or `dispose`. `offset` staggers the entry
        // point deterministically by pitch, so a chord is not one noise
        // playing louder.
        const offset = (pitch % 12) * (src.buffer.duration / 12);
        src.start(at, offset);
      },

      noteOff: (pitch, when) => {
        const at = Math.max(when, ctx.currentTime);
        for (const voice of voices) {
          if (voice.pitch !== pitch || voice.matched) continue;
          voice.matched = true;
          fadeOut(voice, at, releaseS);
          if (voice.ended) forget(voice);
          return;
        }
      },

      allNotesOff: (when) => {
        const at = Math.max(when, ctx.currentTime);
        for (const voice of [...voices]) {
          voice.matched = true;
          fadeOut(voice, at, releaseS);
          if (voice.ended) forget(voice);
        }
      },

      dispose: (when?: Seconds): void => {
        const at = when ?? ctx.currentTime;
        for (const voice of voices) fadeOut(voice, at, releaseS);
        voices.length = 0;
        rampOutAndDisconnect(when, [outGain], { context: ctx });
      },
    });
  },
};
