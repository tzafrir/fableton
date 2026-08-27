// AudioWorkletProcessor for `core.poly-synth` (§7/§14, PLAN.md §18-M0).
//
// Runs on the audio rendering thread, in its own realm (no window/DOM) — see
// worklet-globals.d.ts for the ambient declarations this file relies on
// (`AudioWorkletProcessor`, `registerProcessor`, `sampleRate`, `currentTime`).
// All DSP math is imported from ../devices/core/polySynth/* so it stays
// unit-testable head-on in plain Vitest (§15) and is shared verbatim with
// anything else that ever wants to reason about this instrument offline. The
// class itself is exported for the same reason — see
// ./poly-synth-processor.test.ts, which drives `process()` directly.
//
// Params arrive as real `AudioParam`s (k-rate; see `parameterDescriptors`
// below), bound directly by `ParamHandle.bindAudioParam` on the main-thread
// side (src/devices/core/polySynth.ts) — no message plumbing needed for
// them. Note events (`noteOn`/`noteOff`/`allNotesOff`) arrive over
// `port.onmessage` with an audio-clock `when` that may be several render
// quanta in the future (§12 look-ahead); `NoteEventQueue` holds them until
// `sampleOffsetForBlock` says they belong to the block currently rendering,
// and the sample loop below is SPLIT at each event's offset so a note starts
// on its own sample rather than on the 128-sample block grid — that exact
// `when` is the whole point of §12's two-clock design.
//
// §12 guardrail — "zero allocation in per-tick paths": nothing in `process()`
// allocates. The event ring is preallocated (see `NoteEventQueue`), the ADSR
// config object handed to the envelope is a single preallocated instance
// reused for every note, and every loop is index-based (a `for...of` over the
// voice array allocates an iterator per block).

import { AdsrEnvelope, type AdsrConfig } from "../devices/core/polySynth/envelope";
import {
  NOTE_OFF,
  NOTE_ON,
  NoteEventQueue,
  type QueuedNoteEvent,
} from "../devices/core/polySynth/noteEventQueue";
import { OnePoleLowpass } from "../devices/core/polySynth/onePoleLowpass";
import { midiToFrequencyHz, oscillatorSample, shapeFromIndex } from "../devices/core/polySynth/oscillator";
import { POLY_SYNTH_PROCESSOR_NAME } from "../devices/core/polySynth/processorName";
import { VoiceAllocator } from "../devices/core/polySynth/voiceAllocator";

const MAX_VOICES = 8;

/**
 * Velocity glide when a voice is retriggered or stolen while still sounding.
 * `AdsrEnvelope.noteOn` deliberately ramps from the current level instead of
 * resetting (envelope.ts) and `VoiceAllocator` hands out the least-recently-
 * used slot for the same reason — but the amplitude is `envelope * velocity`,
 * so writing the new velocity instantaneously would step the sample value
 * anyway (level 0.8 at velocity 1.0 stolen for a velocity-0.2 note jumps to
 * 0.16 in one sample: a click, on the audio thread). A few milliseconds of
 * glide keeps that seam continuous — SS7's "click-free" swap/steal rule.
 */
const VELOCITY_GLIDE_SECONDS = 0.004;

/** dB at or below which `gain` means silence, matching the descriptor's
 *  `p.db("gain", { min: -60 })` readout: SS4 makes `toText` the sanctioned
 *  readout of the real value, and it says "-inf dB" here, so the DSP must be
 *  silent rather than 0.001x. Same floor as `gainForValue` in the harness
 *  (src/devices/harness/deviceInstance.ts) applies to a gain-node binding. */
const GAIN_SILENCE_DB = -60;

interface Voice {
  pitch: number | null;
  phase: number;
  /** Cycles per sample for `pitch`, computed once at note-on. */
  phaseInc: number;
  velocity: number;
  /** Where `velocity` is gliding to, and how far it moves per sample. */
  velocityTarget: number;
  velocityStep: number;
  velocitySamplesLeft: number;
  readonly envelope: AdsrEnvelope;
}

function paramAt(parameters: Record<string, Float32Array>, name: string, fallback: number): number {
  return parameters[name]?.[0] ?? fallback;
}

export class PolySynthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: "shape", defaultValue: 0, minValue: 0, maxValue: 3, automationRate: "k-rate" },
      { name: "cutoff", defaultValue: 8000, minValue: 40, maxValue: 18000, automationRate: "k-rate" },
      { name: "attack", defaultValue: 5, minValue: 1, maxValue: 4000, automationRate: "k-rate" },
      { name: "decay", defaultValue: 120, minValue: 1, maxValue: 4000, automationRate: "k-rate" },
      { name: "sustain", defaultValue: 70, minValue: 0, maxValue: 100, automationRate: "k-rate" },
      { name: "release", defaultValue: 250, minValue: 1, maxValue: 6000, automationRate: "k-rate" },
      { name: "gain", defaultValue: 0, minValue: -60, maxValue: 6, automationRate: "k-rate" },
      // ENV 2 — the filter envelope. Amount is in SEMITONES so the sweep
      // covers the same musical interval wherever the cutoff sits; a
      // percentage of Hz would be an octave down low and nothing up high.
      { name: "env2Amount", defaultValue: 0, minValue: -48, maxValue: 48, automationRate: "k-rate" },
      { name: "env2Attack", defaultValue: 5, minValue: 1, maxValue: 4000, automationRate: "k-rate" },
      { name: "env2Decay", defaultValue: 200, minValue: 1, maxValue: 4000, automationRate: "k-rate" },
      { name: "env2Sustain", defaultValue: 0, minValue: 0, maxValue: 100, automationRate: "k-rate" },
      { name: "env2Release", defaultValue: 250, minValue: 1, maxValue: 6000, automationRate: "k-rate" },
    ];
  }

  private readonly allocator = new VoiceAllocator(MAX_VOICES);
  private readonly voices: Voice[];
  private readonly queue = new NoteEventQueue();
  private readonly lowpass = new OnePoleLowpass(sampleRate);
  /** Preallocated and reused per note-on — see the allocation note above. */
  private readonly adsr: AdsrConfig = {
    attackSeconds: 0.005,
    decaySeconds: 0.12,
    sustainLevel: 0.7,
    releaseSeconds: 0.25,
  };

  /**
   * ENV 2, the filter envelope.
   *
   * The lowpass is ONE filter over the mixed voices, not one per voice, so
   * its envelope is shared too: it retriggers on any note-on and releases
   * when the last held note lets go — mono-envelope behaviour, which is what
   * a shared filter can honestly offer and what an acid line wants anyway.
   * Making it per-voice means a filter per voice, which is a different
   * instrument (and a different render budget, SS2).
   *
   * It is evaluated once per BLOCK, not per sample: the cutoff is k-rate
   * because the coefficient costs a `Math.exp`, and 128 samples is 2.7 ms —
   * finer than any filter sweep can be heard to step.
   */
  private readonly filterEnv = new AdsrEnvelope(sampleRate);
  private readonly env2: AdsrConfig = {
    attackSeconds: 0.005,
    decaySeconds: 0.2,
    sustainLevel: 0,
    releaseSeconds: 0.25,
  };
  /** How many note-ons are still held — the gate for `filterEnv`. */
  private heldNotes = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.voices = Array.from({ length: MAX_VOICES }, () => ({
      pitch: null,
      phase: 0,
      phaseInc: 0,
      velocity: 0,
      velocityTarget: 0,
      velocityStep: 0,
      velocitySamplesLeft: 0,
      envelope: new AdsrEnvelope(sampleRate),
    }));
    this.port.onmessage = (event: MessageEvent<QueuedNoteEvent>): void => {
      this.queue.push(event.data);
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const output = outputs[0];
    const blockSize = output?.[0]?.length ?? 0;
    if (output === undefined || blockSize === 0) return true;

    const shape = shapeFromIndex(paramAt(parameters, "shape", 0));
    const cutoffHz = paramAt(parameters, "cutoff", 8000);
    this.adsr.attackSeconds = paramAt(parameters, "attack", 5) / 1000;
    this.adsr.decaySeconds = paramAt(parameters, "decay", 120) / 1000;
    this.adsr.sustainLevel = paramAt(parameters, "sustain", 70) / 100;
    this.adsr.releaseSeconds = paramAt(parameters, "release", 250) / 1000;
    const gainDb = paramAt(parameters, "gain", 0);
    const gainLinear = gainDb <= GAIN_SILENCE_DB ? 0 : 10 ** (gainDb / 20);
    this.env2.attackSeconds = paramAt(parameters, "env2Attack", 5) / 1000;
    this.env2.decaySeconds = paramAt(parameters, "env2Decay", 200) / 1000;
    this.env2.sustainLevel = paramAt(parameters, "env2Sustain", 0) / 100;
    this.env2.releaseSeconds = paramAt(parameters, "env2Release", 250) / 1000;
    const env2Amount = paramAt(parameters, "env2Amount", 0);

    // Advance ENV 2 across this block and take where it lands. Looping a
    // trivial add 128 times costs far less than one `Math.exp` per sample,
    // which is what a per-sample cutoff would cost.
    let env2Level = this.filterEnv.currentLevel;
    for (let n = 0; n < blockSize; n++) env2Level = this.filterEnv.next();
    // Semitones -> a frequency ratio, so the sweep is musically even.
    const modulated =
      env2Amount === 0 ? cutoffHz : cutoffHz * 2 ** ((env2Amount * env2Level) / 12);
    // k-rate: one value for the whole block, so the filter coefficient (a
    // `Math.exp`) is computed here, not per sample (SS2 render-thread budget).
    this.lowpass.setCutoff(Math.min(20000, Math.max(20, modulated)));

    const dueCount = this.queue.collectDue(currentTime, sampleRate, blockSize);
    const voices = this.voices;
    const channelCount = output.length;

    let nextEvent = 0;
    let i = 0;
    while (i < blockSize) {
      // Everything due at or before this sample applies first...
      while (nextEvent < dueCount && this.queue.offsetAt(nextEvent) <= i) {
        this.applyDue(nextEvent);
        nextEvent++;
      }
      // ...then render up to the next event's sample, not past it.
      let until = blockSize;
      if (nextEvent < dueCount) {
        const next = this.queue.offsetAt(nextEvent);
        if (next < until) until = next;
      }
      // Idle fast path: with no voice sounding and the filter settled, every
      // remaining sample of this stretch is exactly zero — skip the voice
      // scan and the filter rather than grinding them for silence. The
      // processor still returns `true` (it must stay alive for the next note),
      // but an idle instrument now costs a fill instead of a full render.
      if (this.allIdle() && this.lowpass.isSettled && this.filterEnv.isIdle) {
        for (let c = 0; c < channelCount; c++) {
          output[c]!.fill(0, i, until);
        }
        i = until;
        continue;
      }
      for (; i < until; i++) {
        let mix = 0;
        for (let v = 0; v < voices.length; v++) {
          const voice = voices[v]!;
          if (voice.pitch === null && voice.envelope.isIdle) continue;
          if (voice.velocitySamplesLeft > 0) {
            voice.velocitySamplesLeft--;
            voice.velocity =
              voice.velocitySamplesLeft === 0
                ? voice.velocityTarget
                : voice.velocity + voice.velocityStep;
          }
          const amplitude = voice.envelope.next();
          mix += oscillatorSample(shape, voice.phase) * amplitude * voice.velocity;
          // `phaseInc` is fixed for the life of the note (computed at
          // note-on), so no `midiToFrequencyHz` per sample per voice.
          voice.phase += voice.phaseInc;
          if (voice.phase > 1) voice.phase -= Math.floor(voice.phase); // keep the accumulator bounded
          if (voice.envelope.isIdle) voice.pitch = null;
        }
        const sample = this.lowpass.process(mix) * gainLinear;
        for (let c = 0; c < channelCount; c++) {
          output[c]![i] = sample;
        }
      }
    }
    return true;
  }

  /** True when no voice is sounding or releasing. */
  private allIdle(): boolean {
    for (let v = 0; v < this.voices.length; v++) {
      const voice = this.voices[v]!;
      if (voice.pitch !== null || !voice.envelope.isIdle) return false;
    }
    return true;
  }

  /** Applies the due-buffer entry at `index` (fields read straight off the
   *  queue's typed arrays — nothing is unpacked into an object). */
  private applyDue(index: number): void {
    const type = this.queue.typeAt(index);
    if (type === NOTE_ON) {
      const pitch = this.queue.pitchAt(index);
      const voice = this.voices[this.allocator.allocate(pitch)];
      if (voice === undefined) return;
      voice.pitch = pitch;
      voice.phaseInc = midiToFrequencyHz(pitch) / sampleRate;
      const raw = this.queue.velAt(index) / 127;
      const vel = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      if (voice.envelope.isIdle) {
        // Silent voice: nothing to glide from, and starting the note at its
        // exact velocity keeps the attack's first sample right.
        voice.velocity = vel;
        voice.velocityTarget = vel;
        voice.velocityStep = 0;
        voice.velocitySamplesLeft = 0;
      } else {
        const samples = Math.max(1, Math.round(VELOCITY_GLIDE_SECONDS * sampleRate));
        voice.velocityTarget = vel;
        voice.velocityStep = (vel - voice.velocity) / samples;
        voice.velocitySamplesLeft = samples;
      }
      voice.envelope.noteOn(this.adsr);
      // ENV 2 retriggers on every note-on (see `filterEnv`).
      this.heldNotes++;
      this.filterEnv.noteOn(this.env2);
      return;
    }
    if (type === NOTE_OFF) {
      const released = this.allocator.release(this.queue.pitchAt(index));
      if (released === null) return;
      this.voices[released]?.envelope.noteOff();
      this.heldNotes = Math.max(0, this.heldNotes - 1);
      // The shared envelope releases only when the LAST note does, so a
      // chord's filter does not snap shut as its first note is let go.
      if (this.heldNotes === 0) this.filterEnv.noteOff();
      return;
    }
    // allNotesOff (§12 "Stop sends allNotesOff(now + e) down every track").
    // Anything still queued for at-or-after this instant was already dropped
    // by `NoteEventQueue.push`, so no ghost note can attack behind this.
    //
    // A panic RELEASES held voices; it deliberately does not hard-cut them
    // (`AdsrEnvelope.reset`), because a step to zero on the render thread is
    // a click and §7's rule is that every teardown is gain-ramped. Voices
    // already in their release tail are left to finish for the same reason —
    // the device's own `dispose` fades the output gain over the harness ramp
    // when the sound really must be gone.
    for (let v = 0; v < this.voices.length; v++) {
      if (this.allocator.pitchOf(v) === null) continue;
      this.voices[v]?.envelope.noteOff();
    }
    this.heldNotes = 0;
    this.filterEnv.noteOff();
    this.allocator.clear();
  }
}

registerProcessor(POLY_SYNTH_PROCESSOR_NAME, PolySynthProcessor);
