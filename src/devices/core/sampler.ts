// `core.sampler` — plays an imported audio file, chromatically.
//
// The instrument that makes "add a wav" mean something: pick a file, and the
// keyboard plays it up and down. One buffer source per note, pitched by
// playback rate, through a filter and an ADSR — the classic shape, and the
// one whose controls a user already knows.
//
// THE FILE IS A SETTING, NOT A PARAM. Params are numbers (SS4), which is what
// makes them automatable, mappable and interpolatable; an `AssetId` is none
// of those and "halfway between two samples" is not a value. So the chosen
// file lives in `DeviceState.settings.sample`, is saved and undone with the
// document, and reaches this instance through `setSetting` — pushed by the
// reconciler, which is the only code that can see both the document and the
// live device. The SAMPLES come the other way, through
// `DeviceServices.assets`, which a device may read but not enumerate.
//
// Because decoding is async and a project loads long before its audio
// finishes decoding, the buffer is resolved AT NOTE TIME rather than cached
// at set time — a note played during loading is silent, and the next one
// sounds, with no invalidation to get wrong.

import type { AssetId, DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

/** Device-local key of the sample slot (public API — see the header). */
export const SAMPLE_SETTING_KEY = "sample";

/** Playback rate for a note, given the sample's root and the tuning knobs. */
export function playbackRateFor(
  pitch: number,
  rootNote: number,
  tuneSemitones: number,
  fineCents: number,
): number {
  const semitones = pitch - rootNote + tuneSemitones + fineCents / 100;
  return 2 ** (semitones / 12);
}

/**
 * The slice of a buffer a voice plays, in SECONDS, from the two percentage
 * knobs. Always at least one sample long and always inside the buffer, so a
 * start dragged past the end cannot produce a source that never stops.
 */
export function sliceOf(
  durationSeconds: number,
  startPercent: number,
  endPercent: number,
): { offset: Seconds; duration: Seconds } {
  const lo = Math.min(startPercent, endPercent) / 100;
  const hi = Math.max(startPercent, endPercent) / 100;
  const offset = Math.min(durationSeconds, Math.max(0, lo * durationSeconds));
  const end = Math.min(durationSeconds, Math.max(offset, hi * durationSeconds));
  return { offset, duration: Math.max(1e-4, end - offset) };
}

interface Voice {
  pitch: number;
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  env: GainNode;
  releasedAt: number | null;
  matched: boolean;
  ended: boolean;
}

const STEAL_S = 0.02;
/** SS2 audio budget, one instrument's share. A sampler voice is one buffer
 *  read plus one biquad — as cheap as the noise instrument's. */
export const MAX_VOICES = 32;
const MAX_TRACKED = 128;

export const Sampler: DeviceDefinition = {
  id: "core.sampler",
  version: 1,
  kind: "instrument",
  label: "Sampler",
  audioIn: [],
  audioOut: [{ id: "out" }],
  settings: [{ key: SAMPLE_SETTING_KEY, label: "Sample", kind: "audioAsset" }],
  params: [
    // The note at which the file plays back untransposed. C3 (60) rather than
    // C1: a sample loaded onto the middle of the keyboard plays at its own
    // speed, which is what "it sounds like the file" means to a user.
    p.stepped("root", "Root", { min: 0, max: 127, default: 60, step: 1 }),
    p.st("tune", "Tune", { min: -24, max: 24, default: 0 }),
    p.continuous("fine", "Fine", { min: -100, max: 100, default: 0, unit: "cents", bipolar: true }),
    p.pct("start", "Start", { default: 0 }),
    p.pct("end", "End", { default: 100 }),
    p.toggle("loop", "Loop", { default: 0 }),
    p.hz("cutoff", "Cutoff", { min: 40, max: 18000, default: 18000 }),
    p.ms("attack", "Attack", { min: 1, max: 4000, default: 2 }),
    p.ms("decay", "Decay", { min: 1, max: 4000, default: 400 }),
    p.pct("sustain", "Sustain", { default: 100 }),
    p.ms("release", "Release", { min: 1, max: 6000, default: 120 }),
    p.db("gain", "Gain", { min: -60, max: 6, default: 0 }),
  ],
  panel: {
    rows: [
      { label: "Pitch", controls: [{ paramId: "root" }, { paramId: "tune" }, { paramId: "fine" }] },
      {
        label: "Region",
        controls: [{ paramId: "start" }, { paramId: "end" }, { paramId: "loop" }],
      },
      { label: "Tone", controls: [{ paramId: "cutoff" }, { paramId: "gain" }] },
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

  create(ctx, io, services): DeviceInstance {
    const outGain = ctx.createGain();
    outGain.connect(io.out);

    let assetId: AssetId | null = null;
    let rootNote = 60;
    let tune = 0;
    let fine = 0;
    let startPercent = 0;
    let endPercent = 100;
    let looping = false;
    let cutoffHz = 18000;
    let attackS = 0.002;
    let decayS = 0.4;
    let sustain = 1;
    let releaseS = 0.12;

    const voices: Voice[] = [];

    const forget = (voice: Voice): void => {
      const index = voices.indexOf(voice);
      if (index >= 0) voices.splice(index, 1);
    };

    const fadeOut = (voice: Voice, when: number, fadeS: number): void => {
      if (voice.releasedAt !== null || voice.ended) return;
      voice.releasedAt = when;
      voice.env.gain.cancelScheduledValues(when);
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
      setSetting: (key, value) => {
        if (key === SAMPLE_SETTING_KEY) assetId = value;
      },
      connectParam: (localId, handle) => {
        if (localId === "root") handle.bindMessage((v) => void (rootNote = Math.round(v)));
        else if (localId === "tune") handle.bindMessage((v) => void (tune = v));
        else if (localId === "fine") handle.bindMessage((v) => void (fine = v));
        else if (localId === "start") handle.bindMessage((v) => void (startPercent = v));
        else if (localId === "end") handle.bindMessage((v) => void (endPercent = v));
        else if (localId === "loop") handle.bindMessage((v) => void (looping = v >= 0.5));
        else if (localId === "cutoff") handle.bindMessage((v) => void (cutoffHz = v));
        else if (localId === "attack") handle.bindMessage((v) => void (attackS = v / 1000));
        else if (localId === "decay") handle.bindMessage((v) => void (decayS = v / 1000));
        else if (localId === "sustain") handle.bindMessage((v) => void (sustain = v / 100));
        else if (localId === "release") handle.bindMessage((v) => void (releaseS = v / 1000));
      },

      noteOn: (pitch, vel, when) => {
        // Resolved per note, not cached: the file may still have been
        // decoding when the setting arrived (see the header).
        const buffer = assetId === null ? undefined : services.assets.buffer(assetId);
        if (buffer === undefined) return;
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

        const slice = sliceOf(buffer.duration, startPercent, endPercent);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = playbackRateFor(pitch, rootNote, tune, fine);
        if (looping) {
          src.loop = true;
          src.loopStart = slice.offset;
          src.loopEnd = slice.offset + slice.duration;
        }

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = cutoffHz;
        filter.Q.value = 0.7;

        const env = ctx.createGain();
        const peak = vel / 127;
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(peak, at + attackS);
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
        // A one-shot ends itself at the end of its slice — no note-off
        // needed for a drum hit dropped on a pad. A LOOPING voice never
        // does, and is stopped by its note-off, a steal, or `dispose`.
        if (looping) src.start(at, slice.offset);
        else src.start(at, slice.offset, slice.duration);
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
