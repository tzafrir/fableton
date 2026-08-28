// AudioWorkletProcessor for `core.wavetable` (SS7/SS14, SS15 "worklets as
// separate entry points").
//
// Everything it computes comes from ../devices/core/wavetable/*, which is
// plain math with no worklet globals — so the oscillator, the filters, the
// LFOs and the matrix are all unit-testable head-on, and this file is the
// composition: read the params, run the voices, sum them.
//
// The shape of a voice, once:
//
//   Osc A ─┐                       ┌─ Filter 1 ─┐
//          ├─ (routing decides) ───┤            ├─→ amp env → pan → out
//   Osc B ─┘                       └─ Filter 2 ─┘
//
// and beside it, feeding any of it, the matrix: two spare envelopes, two
// LFOs, velocity and key, times forty-two amounts.
//
// TWO CLOCKS, deliberately. The amp envelope, the oscillators' phase, their
// Position and their pitch all run per SAMPLE — those are the things whose
// steps you would hear. Everything else (filter coefficients, pan gains, the
// spare envelopes, the LFOs, the matrix sums) runs once per 128-sample block
// and, where it matters, is interpolated across the block. A `Math.tan` per
// sample per filter per voice is not a budget SS2 has, and 2.7 ms is finer
// than any of these can be heard to move.

import { AdsrEnvelope, type AdsrConfig } from "../devices/core/polySynth/envelope";
import {
  NOTE_OFF,
  NOTE_ON,
  NoteEventQueue,
  type QueuedNoteEvent,
} from "../devices/core/polySynth/noteEventQueue";
import { midiToFrequencyHz } from "../devices/core/polySynth/oscillator";
import { Lfo } from "../devices/core/wavetable/lfo";
import {
  SOURCE_COUNT,
  SOURCE_ENV2,
  SOURCE_ENV3,
  SOURCE_KEY,
  SOURCE_LFO1,
  SOURCE_LFO2,
  SOURCE_VEL,
  TARGET_AMP,
  TARGET_A_POS,
  TARGET_B_POS,
  TARGET_COUNT,
  TARGET_CUT1,
  TARGET_CUT2,
  TARGET_PAN,
  TARGET_PITCH,
  MOD_PARAM_IDS,
  applyMatrix,
  keyTrackValue,
} from "../devices/core/wavetable/matrix";
import { WavetableOscillator } from "../devices/core/wavetable/oscillator";
import {
  envParamIds,
  filterParamIds,
  lfoParamIds,
  oscParamIds,
  workletParameterDescriptors,
} from "../devices/core/wavetable/params";
import { WAVETABLE_PROCESSOR_NAME } from "../devices/core/wavetable/processorName";
import { StereoFilter, softLimit } from "../devices/core/wavetable/svf";
import { FRAME_COUNT, MIP_LEVELS, mipLength, type WavetableData } from "../devices/core/wavetable/tables";
import { VoicePool } from "../devices/core/wavetable/voicePool";

/** Slots the pool is built with; the Voices param picks how many are used. */
const MAX_VOICES = 16;

/** dB at or below which `gain` is silence — the descriptor reads "-inf dB"
 *  there, and SS4 makes that readout the truth about the value. */
const GAIN_SILENCE_DB = -60;

/** Velocity's hard-wired share of the amplitude. The matrix has a
 *  `Velocity → Amp` cell for more, but an instrument that ignores velocity
 *  until someone finds that cell is an instrument that feels broken. */
const VELOCITY_FLOOR = 0.3;

const OSC_A = oscParamIds(0);
const OSC_B = oscParamIds(1);
const F1 = filterParamIds(0);
const F2 = filterParamIds(1);
const ENV_AMP = envParamIds(0);
const ENV_2 = envParamIds(1);
const ENV_3 = envParamIds(2);
const LFO_1 = lfoParamIds(0);
const LFO_2 = lfoParamIds(1);
/** Flat, row-major — the order `applyMatrix` expects. */
const MOD_IDS: readonly string[] = MOD_PARAM_IDS.flat();

const ROUTING_SERIAL = 0;
const ROUTING_PARALLEL = 1;
const ROUTING_SPLIT = 2;

interface Voice {
  pitch: number | null;
  /** Amplitude from velocity alone, hard-wired (see `VELOCITY_FLOOR`). */
  velGain: number;
  /** Raw semitones from C3 — what filter keytracking follows. */
  keySemis: number;
  /** The clamped, normalised version the matrix's `Key` source uses. */
  key: number;
  /** Where the note is now and where glide is taking it, in MIDI semitones. */
  semis: number;
  targetSemis: number;
  lfo1Value: number;
  lfo2Value: number;
  readonly oscA: WavetableOscillator;
  readonly oscB: WavetableOscillator;
  readonly ampEnv: AdsrEnvelope;
  readonly env2: AdsrEnvelope;
  readonly env3: AdsrEnvelope;
  readonly lfo1: Lfo;
  readonly lfo2: Lfo;
  readonly f1: StereoFilter;
  readonly f2: StereoFilter;
  readonly srcStart: Float32Array;
  readonly srcEnd: Float32Array;
  readonly modStart: Float32Array;
  readonly modEnd: Float32Array;
  /** Per-sample interpolants: value now, and how far it moves each sample. */
  posA: number;
  posAStep: number;
  posB: number;
  posBStep: number;
  incA: number;
  incAStep: number;
  incB: number;
  incBStep: number;
  ampMul: number;
  ampMulStep: number;
  /** True once this block's sources have been advanced, so a note-on
   *  arriving mid-block re-derives without advancing them twice. */
  preparedThisBlock: boolean;
  /** Per-block: pan gains for each oscillator. */
  gLA: number;
  gRA: number;
  gLB: number;
  gRB: number;
}

function paramAt(parameters: Record<string, Float32Array>, name: string, fallback: number): number {
  return parameters[name]?.[0] ?? fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The table an oscillator falls back to before the main thread's real one
 * arrives (or if it never does): one sine frame, at every mip level.
 *
 * Built here rather than left as silence on purpose. A missing table is a
 * bug in the plumbing, and a bug you can hear as "my synth is a sine" is one
 * somebody reports; a bug you hear as silence gets blamed on the routing, the
 * mixer, the browser, and eventually the DAW.
 */
function sineFallback(): WavetableData {
  const levels: Float32Array[][] = [];
  for (let level = 0; level < MIP_LEVELS; level++) {
    const length = mipLength(level);
    const frame = new Float32Array(length);
    for (let i = 0; i < length; i++) frame[i] = Math.sin((2 * Math.PI * i) / length);
    levels.push(new Array<Float32Array>(FRAME_COUNT).fill(frame));
  }
  return { index: -1, frameCount: FRAME_COUNT, levels };
}

/** The main thread builds the tables (they are megabytes of samples and a
 *  handful of FFTs) and posts them here. Two messages, so a table already
 *  cached is selected without being sent again. */
interface TableDataMessage {
  type: "table";
  index: number;
  data: WavetableData;
}
interface TableSelectMessage {
  type: "osc";
  osc: number;
  index: number;
}
type WavetableMessage = QueuedNoteEvent | TableDataMessage | TableSelectMessage;

export class WavetableProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return workletParameterDescriptors();
  }

  private readonly pool = new VoicePool(MAX_VOICES);
  private readonly voices: Voice[];
  private readonly queue = new NoteEventQueue();
  private readonly fallbackTable = sineFallback();
  /** Tables the main thread has posted, by catalogue index. */
  private readonly tables = new Map<number, WavetableData>();
  private tableIndexA = 0;
  private tableIndexB = 0;

  private readonly adsrAmp: AdsrConfig = {
    attackSeconds: 0.004,
    decaySeconds: 0.8,
    sustainLevel: 0.7,
    releaseSeconds: 0.3,
  };
  private readonly adsr2: AdsrConfig = {
    attackSeconds: 0.002,
    decaySeconds: 0.4,
    sustainLevel: 0,
    releaseSeconds: 0.2,
  };
  private readonly adsr3: AdsrConfig = {
    attackSeconds: 0.06,
    decaySeconds: 1.5,
    sustainLevel: 0.4,
    releaseSeconds: 0.6,
  };
  /** Matrix amounts, row-major and already divided by 100. */
  private readonly amounts = new Float32Array(SOURCE_COUNT * TARGET_COUNT);

  // Per-block scratch, read straight off the params. Fields rather than an
  // object literal per block: SS12's "zero allocation in per-tick paths".
  private aOn = true;
  private bOn = false;
  private aPos = 0;
  private bPos = 0;
  private aLevel = 1;
  private bLevel = 1;
  private aPan = 0;
  private bPan = 0;
  private aDetune = 0;
  private bDetune = 0;
  private routing = ROUTING_SERIAL;
  private f1On = true;
  private f2On = false;
  private f1Type = 1;
  private f2Type = 2;
  private f1Cutoff = 4000;
  private f2Cutoff = 400;
  private f1Res = 0.15;
  private f2Res = 0;
  private f1Drive = 0;
  private f2Drive = 0;
  private f1Key = 0;
  private f2Key = 0;
  private lfo1Shape = 0;
  private lfo2Shape = 1;
  private lfo1Inc = 0;
  private lfo2Inc = 0;
  private lfo1Retrig = true;
  private lfo2Retrig = true;
  private glideCoeff = 1;
  private gainLinear = 1;
  private tableA: WavetableData;
  private tableB: WavetableData;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.tableA = this.fallbackTable;
    this.tableB = this.fallbackTable;
    this.voices = Array.from({ length: MAX_VOICES }, (_unused, i) => ({
      pitch: null,
      velGain: 0,
      keySemis: 0,
      key: 0,
      semis: 60,
      targetSemis: 60,
      lfo1Value: 0,
      lfo2Value: 0,
      oscA: new WavetableOscillator(),
      oscB: new WavetableOscillator(),
      ampEnv: new AdsrEnvelope(sampleRate),
      env2: new AdsrEnvelope(sampleRate),
      env3: new AdsrEnvelope(sampleRate),
      // Seeded per slot: two voices whose S&H picked the same numbers would
      // be one voice as far as that modulation is concerned.
      lfo1: new Lfo(0x9e3779b9 + i * 2654435761),
      lfo2: new Lfo(0x85ebca6b + i * 2246822519),
      f1: new StereoFilter(),
      f2: new StereoFilter(),
      srcStart: new Float32Array(SOURCE_COUNT),
      srcEnd: new Float32Array(SOURCE_COUNT),
      modStart: new Float32Array(TARGET_COUNT),
      modEnd: new Float32Array(TARGET_COUNT),
      posA: 0,
      posAStep: 0,
      posB: 0,
      posBStep: 0,
      incA: 0,
      incAStep: 0,
      incB: 0,
      incBStep: 0,
      ampMul: 1,
      ampMulStep: 0,
      preparedThisBlock: false,
      gLA: 0.707,
      gRA: 0.707,
      gLB: 0.707,
      gRB: 0.707,
    }));
    this.port.onmessage = (event: MessageEvent<WavetableMessage>): void => {
      const data = event.data;
      if (data.type === "table") {
        this.tables.set(data.index, data.data);
        return;
      }
      if (data.type === "osc") {
        if (data.osc === 0) this.tableIndexA = data.index;
        else this.tableIndexB = data.index;
        return;
      }
      this.queue.push(data);
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const output = outputs[0];
    const left = output?.[0];
    if (output === undefined || left === undefined) return true;
    const right = output[1] ?? left;
    const blockSize = left.length;
    if (blockSize === 0) return true;

    this.readParams(parameters);

    const dueCount = this.queue.collectDue(currentTime, sampleRate, blockSize);
    for (let v = 0; v < this.voices.length; v++) {
      const voice = this.voices[v]!;
      voice.preparedThisBlock = false;
      if (voice.pitch === null && voice.ampEnv.isIdle) continue;
      this.prepareVoice(voice, blockSize, true);
    }

    let nextEvent = 0;
    let i = 0;
    while (i < blockSize) {
      while (nextEvent < dueCount && this.queue.offsetAt(nextEvent) <= i) {
        this.applyDue(nextEvent, blockSize - i);
        nextEvent++;
      }
      let until = blockSize;
      if (nextEvent < dueCount) {
        const next = this.queue.offsetAt(nextEvent);
        if (next < until) until = next;
      }
      if (this.allSilent()) {
        left.fill(0, i, until);
        if (right !== left) right.fill(0, i, until);
        i = until;
        continue;
      }
      for (; i < until; i++) {
        let sumL = 0;
        let sumR = 0;
        for (let v = 0; v < this.voices.length; v++) {
          const voice = this.voices[v]!;
          if (voice.pitch === null && voice.ampEnv.isIdle) continue;
          sumL += this.renderVoiceLeft(voice);
          sumR += this.lastRight;
        }
        left[i] = sumL * this.gainLinear;
        right[i] = sumR * this.gainLinear;
      }
    }
    return true;
  }

  /** The right channel of the sample `renderVoiceLeft` just produced. One
   *  voice cannot return two numbers without allocating; a field can. */
  private lastRight = 0;

  private renderVoiceLeft(voice: Voice): number {
    const amp = voice.ampEnv.next();
    if (voice.ampEnv.isIdle) voice.pitch = null;

    let aL = 0;
    let aR = 0;
    if (this.aOn) {
      const s = voice.oscA.next(voice.posA, voice.incA) * this.aLevel;
      aL = s * voice.gLA;
      aR = s * voice.gRA;
    }
    let bL = 0;
    let bR = 0;
    if (this.bOn) {
      const s = voice.oscB.next(voice.posB, voice.incB) * this.bLevel;
      bL = s * voice.gLB;
      bR = s * voice.gRB;
    }
    voice.posA += voice.posAStep;
    voice.posB += voice.posBStep;
    voice.incA += voice.incAStep;
    voice.incB += voice.incBStep;
    voice.ampMul += voice.ampMulStep;

    let outL: number;
    let outR: number;
    if (this.routing === ROUTING_SPLIT) {
      // A through Filter 1, B through Filter 2 — each bypassing when its
      // filter is off, so switching a filter out never mutes an oscillator.
      outL = this.f1On ? voice.f1.processLeft(aL) : aL;
      outR = this.f1On ? voice.f1.processRight(aR) : aR;
      outL += this.f2On ? voice.f2.processLeft(bL) : bL;
      outR += this.f2On ? voice.f2.processRight(bR) : bR;
    } else if (this.routing === ROUTING_PARALLEL) {
      const mixL = aL + bL;
      const mixR = aR + bR;
      if (!this.f1On && !this.f2On) {
        outL = mixL;
        outR = mixR;
      } else {
        outL = 0;
        outR = 0;
        if (this.f1On) {
          outL += voice.f1.processLeft(mixL);
          outR += voice.f1.processRight(mixR);
        }
        if (this.f2On) {
          outL += voice.f2.processLeft(mixL);
          outR += voice.f2.processRight(mixR);
        }
      }
    } else {
      outL = aL + bL;
      outR = aR + bR;
      if (this.f1On) {
        outL = voice.f1.processLeft(outL);
        outR = voice.f1.processRight(outR);
      }
      if (this.f2On) {
        outL = voice.f2.processLeft(outL);
        outR = voice.f2.processRight(outR);
      }
    }

    const level = amp * voice.velGain * (voice.ampMul < 0 ? 0 : voice.ampMul);
    this.lastRight = softLimit(outR * level);
    return softLimit(outL * level);
  }

  /**
   * True when nothing can produce a non-zero sample: no voice sounding.
   *
   * A ringing filter does not need checking, and the reason is the ordering:
   * the filters are INSIDE each voice and the amp envelope multiplies their
   * output, so a voice whose envelope has reached zero contributes exactly
   * zero however loudly its filter is still resonating. (`core.poly-synth`
   * does have to check, because its one filter sits after the mix.) Its state
   * is cleared the next time the slot takes a note.
   */
  private allSilent(): boolean {
    for (let v = 0; v < this.voices.length; v++) {
      const voice = this.voices[v]!;
      if (voice.pitch !== null || !voice.ampEnv.isIdle) return false;
    }
    return true;
  }

  private readParams(parameters: Record<string, Float32Array>): void {
    this.pool.setLimit(paramAt(parameters, "voices", 8));

    const glideMs = paramAt(parameters, "glide", 0);
    // One block's worth of an exponential approach. Zero glide is exact
    // (coefficient 1) rather than "very fast": a portamento knob at zero has
    // to mean no portamento, not a 3 ms one.
    this.glideCoeff =
      glideMs <= 0 ? 1 : 1 - Math.exp((-128 / sampleRate) * (5 / (glideMs / 1000)));

    this.aOn = paramAt(parameters, OSC_A.on, 1) >= 0.5;
    this.bOn = paramAt(parameters, OSC_B.on, 0) >= 0.5;
    this.aPos = paramAt(parameters, OSC_A.pos, 0);
    this.bPos = paramAt(parameters, OSC_B.pos, 0);
    this.aLevel = paramAt(parameters, OSC_A.level, 100) / 100;
    this.bLevel = paramAt(parameters, OSC_B.level, 100) / 100;
    this.aPan = paramAt(parameters, OSC_A.pan, 0);
    this.bPan = paramAt(parameters, OSC_B.pan, 0);
    this.aDetune = paramAt(parameters, OSC_A.coarse, 0) + paramAt(parameters, OSC_A.fine, 0) / 100;
    this.bDetune = paramAt(parameters, OSC_B.coarse, 0) + paramAt(parameters, OSC_B.fine, 0) / 100;

    this.routing = Math.round(paramAt(parameters, "routing", 0));
    this.f1On = paramAt(parameters, F1.on, 1) >= 0.5;
    this.f2On = paramAt(parameters, F2.on, 0) >= 0.5;
    this.f1Type = paramAt(parameters, F1.type, 1);
    this.f2Type = paramAt(parameters, F2.type, 2);
    this.f1Cutoff = paramAt(parameters, F1.cutoff, 4000);
    this.f2Cutoff = paramAt(parameters, F2.cutoff, 400);
    this.f1Res = paramAt(parameters, F1.res, 15) / 100;
    this.f2Res = paramAt(parameters, F2.res, 0) / 100;
    this.f1Drive = paramAt(parameters, F1.drive, 0);
    this.f2Drive = paramAt(parameters, F2.drive, 0);
    this.f1Key = paramAt(parameters, F1.key, 0) / 100;
    this.f2Key = paramAt(parameters, F2.key, 0) / 100;

    this.adsrAmp.attackSeconds = paramAt(parameters, ENV_AMP.attack, 4) / 1000;
    this.adsrAmp.decaySeconds = paramAt(parameters, ENV_AMP.decay, 800) / 1000;
    this.adsrAmp.sustainLevel = paramAt(parameters, ENV_AMP.sustain, 70) / 100;
    this.adsrAmp.releaseSeconds = paramAt(parameters, ENV_AMP.release, 300) / 1000;
    this.adsr2.attackSeconds = paramAt(parameters, ENV_2.attack, 2) / 1000;
    this.adsr2.decaySeconds = paramAt(parameters, ENV_2.decay, 400) / 1000;
    this.adsr2.sustainLevel = paramAt(parameters, ENV_2.sustain, 0) / 100;
    this.adsr2.releaseSeconds = paramAt(parameters, ENV_2.release, 200) / 1000;
    this.adsr3.attackSeconds = paramAt(parameters, ENV_3.attack, 60) / 1000;
    this.adsr3.decaySeconds = paramAt(parameters, ENV_3.decay, 1500) / 1000;
    this.adsr3.sustainLevel = paramAt(parameters, ENV_3.sustain, 40) / 100;
    this.adsr3.releaseSeconds = paramAt(parameters, ENV_3.release, 600) / 1000;

    this.lfo1Shape = paramAt(parameters, LFO_1.shape, 0);
    this.lfo2Shape = paramAt(parameters, LFO_2.shape, 1);
    this.lfo1Inc = (paramAt(parameters, LFO_1.rate, 2) * 128) / sampleRate;
    this.lfo2Inc = (paramAt(parameters, LFO_2.rate, 0.5) * 128) / sampleRate;
    this.lfo1Retrig = paramAt(parameters, LFO_1.retrig, 1) >= 0.5;
    this.lfo2Retrig = paramAt(parameters, LFO_2.retrig, 1) >= 0.5;

    for (let n = 0; n < MOD_IDS.length; n++) {
      this.amounts[n] = paramAt(parameters, MOD_IDS[n]!, 0) / 100;
    }

    const gainDb = paramAt(parameters, "gain", -6);
    this.gainLinear = gainDb <= GAIN_SILENCE_DB ? 0 : 10 ** (gainDb / 20);

    this.tableA = this.tables.get(this.tableIndexA) ?? this.fallbackTable;
    this.tableB = this.tables.get(this.tableIndexB) ?? this.fallbackTable;
  }

  /**
   * Everything a voice needs for the next `samples` samples: its modulation
   * sums at the start and the end of the stretch, the per-sample steps
   * between them, and the filter coefficients for the middle.
   *
   * The mid-point is what the filters are tuned to, not the start: a cutoff
   * held at the value it had 2.7 ms ago lags a fast sweep by half a block
   * every block, and half a block of lag on an envelope-swept filter is
   * audible as a softened attack.
   *
   * `advance` is false for the second call in a block — a note-on landing on
   * a voice that was already sounding, which has to RE-DERIVE its pitch and
   * its filter for the new note but must not run its spare envelopes, its
   * LFOs and its glide through the same block twice.
   */
  private prepareVoice(voice: Voice, samples: number, advance: boolean): void {
    const span = samples < 1 ? 1 : samples;
    voice.preparedThisBlock = true;

    // Glide, then this block's base frequency.
    if (advance) voice.semis += (voice.targetSemis - voice.semis) * this.glideCoeff;
    const baseHz = midiToFrequencyHz(voice.semis);

    const src = voice.srcStart;
    src[SOURCE_ENV2] = voice.env2.currentLevel;
    src[SOURCE_ENV3] = voice.env3.currentLevel;
    src[SOURCE_LFO1] = voice.lfo1Value;
    src[SOURCE_LFO2] = voice.lfo2Value;
    src[SOURCE_VEL] = voice.velGain;
    src[SOURCE_KEY] = voice.key;

    // Advance the block-rate sources to where they land at the end of it.
    if (advance) {
      for (let n = 0; n < span; n++) voice.env2.next();
      for (let n = 0; n < span; n++) voice.env3.next();
      voice.lfo1Value = voice.lfo1.next(this.lfo1Shape, (this.lfo1Inc * span) / 128);
      voice.lfo2Value = voice.lfo2.next(this.lfo2Shape, (this.lfo2Inc * span) / 128);
    }

    const next = voice.srcEnd;
    next[SOURCE_ENV2] = voice.env2.currentLevel;
    next[SOURCE_ENV3] = voice.env3.currentLevel;
    next[SOURCE_LFO1] = voice.lfo1Value;
    next[SOURCE_LFO2] = voice.lfo2Value;
    next[SOURCE_VEL] = voice.velGain;
    next[SOURCE_KEY] = voice.key;

    applyMatrix(this.amounts, src, voice.modStart);
    applyMatrix(this.amounts, next, voice.modEnd);
    const m0 = voice.modStart;
    const m1 = voice.modEnd;

    voice.posA = clamp((this.aPos + (m0[TARGET_A_POS] ?? 0)) / 100, 0, 1);
    voice.posAStep = (clamp((this.aPos + (m1[TARGET_A_POS] ?? 0)) / 100, 0, 1) - voice.posA) / span;
    voice.posB = clamp((this.bPos + (m0[TARGET_B_POS] ?? 0)) / 100, 0, 1);
    voice.posBStep = (clamp((this.bPos + (m1[TARGET_B_POS] ?? 0)) / 100, 0, 1) - voice.posB) / span;

    const incA0 = (baseHz * 2 ** ((this.aDetune + (m0[TARGET_PITCH] ?? 0)) / 12)) / sampleRate;
    const incA1 = (baseHz * 2 ** ((this.aDetune + (m1[TARGET_PITCH] ?? 0)) / 12)) / sampleRate;
    voice.incA = incA0;
    voice.incAStep = (incA1 - incA0) / span;
    const incB0 = (baseHz * 2 ** ((this.bDetune + (m0[TARGET_PITCH] ?? 0)) / 12)) / sampleRate;
    const incB1 = (baseHz * 2 ** ((this.bDetune + (m1[TARGET_PITCH] ?? 0)) / 12)) / sampleRate;
    voice.incB = incB0;
    voice.incBStep = (incB1 - incB0) / span;

    voice.oscA.prepare(this.tableA, incA0);
    voice.oscB.prepare(this.tableB, incB0);

    const amp0 = clamp(1 + (m0[TARGET_AMP] ?? 0), 0, 2);
    const amp1 = clamp(1 + (m1[TARGET_AMP] ?? 0), 0, 2);
    voice.ampMul = amp0;
    voice.ampMulStep = (amp1 - amp0) / span;

    // Pan is per block: an LFO at the top of its range still only moves half
    // a percent of a cycle in 2.7 ms, and equal-power gains cost two
    // trigonometric calls each.
    const panMod = ((m0[TARGET_PAN] ?? 0) + (m1[TARGET_PAN] ?? 0)) / 2;
    const panA = clamp(this.aPan + panMod, -1, 1);
    const panB = clamp(this.bPan + panMod, -1, 1);
    const angleA = ((panA + 1) * Math.PI) / 4;
    const angleB = ((panB + 1) * Math.PI) / 4;
    voice.gLA = Math.cos(angleA);
    voice.gRA = Math.sin(angleA);
    voice.gLB = Math.cos(angleB);
    voice.gRB = Math.sin(angleB);

    const cutMod1 = ((m0[TARGET_CUT1] ?? 0) + (m1[TARGET_CUT1] ?? 0)) / 2;
    const cutMod2 = ((m0[TARGET_CUT2] ?? 0) + (m1[TARGET_CUT2] ?? 0)) / 2;
    if (this.f1On) {
      const hz = clamp(
        this.f1Cutoff * 2 ** ((this.f1Key * voice.keySemis + cutMod1) / 12),
        20,
        20000,
      );
      voice.f1.configure(this.f1Type, hz, this.f1Res, this.f1Drive, sampleRate);
    }
    if (this.f2On) {
      const hz = clamp(
        this.f2Cutoff * 2 ** ((this.f2Key * voice.keySemis + cutMod2) / 12),
        20,
        20000,
      );
      voice.f2.configure(this.f2Type, hz, this.f2Res, this.f2Drive, sampleRate);
    }
  }

  private applyDue(index: number, samplesLeft: number): void {
    const type = this.queue.typeAt(index);
    if (type === NOTE_ON) {
      const pitch = this.queue.pitchAt(index);
      const slot = this.pool.allocate(pitch);
      const voice = this.voices[slot];
      if (voice === undefined) return;
      const raw = this.queue.velAt(index) / 127;
      const vel = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const fresh = voice.ampEnv.isIdle;
      voice.pitch = pitch;
      voice.velGain = VELOCITY_FLOOR + (1 - VELOCITY_FLOOR) * vel;
      voice.keySemis = pitch - 60;
      voice.key = keyTrackValue(pitch);
      voice.targetSemis = pitch;
      // Glide slides from wherever this slot was; a slot that was silent has
      // nowhere to slide from, so it starts in tune.
      if (fresh || this.glideCoeff >= 1) voice.semis = pitch;
      if (fresh) {
        voice.oscA.reset();
        voice.oscB.reset();
        voice.f1.reset();
        voice.f2.reset();
      }
      voice.ampEnv.noteOn(this.adsrAmp);
      voice.env2.noteOn(this.adsr2);
      voice.env3.noteOn(this.adsr3);
      if (this.lfo1Retrig) voice.lfo1.reset();
      if (this.lfo2Retrig) voice.lfo2.reset();
      this.prepareVoice(voice, samplesLeft, !voice.preparedThisBlock);
      return;
    }
    if (type === NOTE_OFF) {
      const released = this.pool.release(this.queue.pitchAt(index));
      if (released === null) return;
      const voice = this.voices[released];
      if (voice === undefined) return;
      voice.ampEnv.noteOff();
      voice.env2.noteOff();
      voice.env3.noteOff();
      return;
    }
    // allNotesOff — released, never hard-cut: a step to zero on the render
    // thread is a click, and SS7 wants every teardown gain-ramped.
    for (let v = 0; v < this.voices.length; v++) {
      if (this.pool.pitchOf(v) === null) continue;
      const voice = this.voices[v]!;
      voice.ampEnv.noteOff();
      voice.env2.noteOff();
      voice.env3.noteOff();
    }
    this.pool.clear();
  }
}

registerProcessor(WAVETABLE_PROCESSOR_NAME, WavetableProcessor);
