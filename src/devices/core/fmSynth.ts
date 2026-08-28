// `core.fm` — a four-operator FM instrument, node-per-voice (SS14: "an
// AudioWorkletProcessor or node-per-voice graph for simple synths"), built
// the way Ableton's Operator is: four operators, eleven algorithms wiring
// them, and an envelope on every one of them.
//
// It replaces a two-operator version whose knobs (`index`, `indexEnd`,
// `indexDecay`) described the SHAPE of one modulator's envelope in three
// separate continuous numbers. That is a workable synth and an unteachable
// one: the numbers named an implementation rather than a thing on a panel,
// nothing about them said "this is an envelope", and there was exactly one
// modulator to point them at. Four operators × one envelope each says the
// same thing in the vocabulary every FM synth since 1983 has used.
//
// The three ideas that make it musical, all of them inherited:
//
//  * FREQUENCY IS A RATIO, and the ratio is an INTEGER plus hundredths.
//    An operator runs at `noteHz * (coarse + fine/100)`, so a patch sounds
//    like itself on every key. Integer ratios give harmonic spectra (bells,
//    organs, brass); the fine offset detunes just off harmonic, which is
//    where the beating and the metallic edge live. Coarse is a STEPPED param
//    for the same reason it is a stepped knob on the hardware: 2 and 3 are
//    musical, 2.4 is a mistake you make with a mouse.
//
//  * DEVIATION SCALES WITH THE MODULATOR'S OWN FREQUENCY. The textbook
//    modulation index is deviation over modulator frequency, so a level of
//    50 means the same brightness whether the operator is at 100 Hz or 10
//    kHz — and, crucially, the same on the bottom octave as on the top. A
//    fixed depth in Hz makes low notes dull and high notes noise.
//
//  * A MODULATOR'S ENVELOPE IS ITS TIMBRE. On a carrier, the envelope is
//    loudness — the familiar one. On a modulator, exactly the same envelope
//    is BRIGHTNESS: a bell is an operator whose level collapses in 300 ms
//    over a carrier that rings for four seconds. That is why every operator
//    has a full ADSR rather than the carriers having envelopes and the
//    modulators having a decay knob.
//
// Per voice the graph is one oscillator and one gain per operator, wired by
// the algorithm — eight nodes for the four-operator maximum, against the six
// the two-operator version used for two.
//
//   operator i:  osc(noteHz * ratio) -> env
//   carrier:     env -> voiceOut          (env peaks at level, × velocity)
//   modulator:   env -> target.frequency  (env peaks at index × its own Hz)

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { dbToGain, deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import {
  ALGORITHM_LABELS,
  OPERATOR_COUNT,
  OPERATOR_NAMES,
  OUT,
  algorithmAt,
  buildOrder,
} from "./operator/algorithms";

export function midiToHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

/** SS2 audio budget, spent on one instrument (the pluck's ceiling). Four
 *  operators is twice the nodes per voice, so the ceiling is half what the
 *  two-operator version could afford. */
export const MAX_VOICES = 12;
/** Cap on finished-but-unmatched voices kept only for note-off pairing. */
const MAX_TRACKED = 128;
const STEAL_S = 0.02;

/** Oscillator shapes an operator can run. Sine is FM's native shape — the
 *  spectrum is entirely the modulation — and the other three are the shortcut
 *  to a bright result without stacking operators to get there. */
export const OPERATOR_WAVES = ["Sine", "Saw", "Square", "Triangle"] as const;
const WAVE_TYPES: readonly OscillatorType[] = ["sine", "sawtooth", "square", "triangle"];

/**
 * The modulation index at level 100.
 *
 * Twelve is the ceiling of the useful range rather than of the possible one:
 * past roughly this, a sine modulator's sidebands are dense enough that the
 * result reads as noise on every ratio, so the top of the knob would be a
 * region where turning it further changes nothing you can name. Stacking
 * operators, not turning one past 12, is how FM gets more extreme.
 */
export const MAX_INDEX = 12;

/** Local param ids for one operator, e.g. `bCoarse`. Every device param is
 *  named through here so the device, the editor and the tests cannot drift. */
export function operatorParamIds(op: number): {
  on: string;
  wave: string;
  coarse: string;
  fine: string;
  level: string;
  attack: string;
  decay: string;
  sustain: string;
  release: string;
} {
  const n = (OPERATOR_NAMES[op] ?? "A").toLowerCase();
  return {
    on: `${n}On`,
    wave: `${n}Wave`,
    coarse: `${n}Coarse`,
    fine: `${n}Fine`,
    level: `${n}Level`,
    attack: `${n}Attack`,
    decay: `${n}Decay`,
    sustain: `${n}Sustain`,
    release: `${n}Release`,
  };
}

/**
 * Factory defaults, per operator.
 *
 * A and B on, C and D off, in the serial algorithm: that is the
 * two-operator patch the previous version WAS, so opening an old project (or
 * a new track) still gives the sound people had. Turning C on is then one
 * click, and the algorithm knob is a tour of what four gets you.
 */
const DEFAULTS = [
  // A — the carrier you always hear.
  { on: 1, wave: 0, coarse: 1, fine: 0, level: 100, attack: 4, decay: 900, sustain: 45, release: 260 },
  // B — the modulator, with a fast-collapsing envelope: bright strike,
  // simple tail. This is the "index envelope" the old device spelt out in
  // three knobs, said in the same language as everything else.
  { on: 1, wave: 0, coarse: 2, fine: 0, level: 42, attack: 2, decay: 350, sustain: 8, release: 220 },
  // C and D — off, but parked somewhere useful. A third harmonic and a
  // fifth: switch either on and you get a recognisable timbre, not a mess.
  { on: 0, wave: 0, coarse: 3, fine: 0, level: 30, attack: 2, decay: 500, sustain: 15, release: 220 },
  { on: 0, wave: 0, coarse: 5, fine: 0, level: 22, attack: 2, decay: 250, sustain: 0, release: 220 },
] as const;

interface OperatorSettings {
  on: number;
  wave: number;
  coarse: number;
  fine: number;
  level: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

interface OperatorNodes {
  osc: OscillatorNode;
  env: GainNode;
}

interface Voice {
  pitch: number;
  operators: OperatorNodes[];
  /** The longest release among the operators that were actually sounding —
   *  what a note-off has to wait out before the nodes can be stopped. */
  releaseS: number;
  releasedAt: number | null;
  matched: boolean;
  ended: boolean;
}

function operatorParams(op: number) {
  const ids = operatorParamIds(op);
  const name = OPERATOR_NAMES[op] ?? "A";
  const d = DEFAULTS[op] ?? DEFAULTS[0];
  return [
    p.toggle(ids.on, `${name} On`, { default: d.on }),
    p.enum(ids.wave, `${name} Wave`, { labels: [...OPERATOR_WAVES], default: d.wave }),
    // Integers, both of them, and the pair reads as one number: coarse 2 +
    // fine 50 is a ratio of 2.50. Ableton splits the same value the same way,
    // and for the same reason — the integer is the musical choice and the
    // hundredths are the detune.
    p.stepped(ids.coarse, `${name} Coarse`, { min: 1, max: 32, step: 1, default: d.coarse }),
    p.stepped(ids.fine, `${name} Fine`, { min: 0, max: 99, step: 1, default: d.fine }),
    p.stepped(ids.level, `${name} Level`, { min: 0, max: 100, step: 1, default: d.level, unit: "%" }),
    p.ms(ids.attack, `${name} Attack`, { min: 0, max: 4000, default: d.attack }),
    p.ms(ids.decay, `${name} Decay`, { min: 5, max: 8000, default: d.decay }),
    p.pct(ids.sustain, `${name} Sustain`, { default: d.sustain }),
    p.ms(ids.release, `${name} Release`, { min: 5, max: 8000, default: d.release }),
  ];
}

export const FmSynth: DeviceDefinition = {
  id: "core.fm",
  // v2: the two-operator param set (`ratio`, `index`, `indexEnd`,
  // `indexDecay`, one shared envelope) is gone entirely. Nothing carries
  // over, so this is a version bump rather than an additive change — a saved
  // project's old values are dropped with a warning by the codec's unknown-
  // param path rather than being silently reinterpreted as something else.
  version: 2,
  kind: "instrument",
  label: "Operator",
  audioIn: [],
  audioOut: [{ id: "out" }],
  editor: "operator",
  params: [
    p.enum("algorithm", "Algorithm", { labels: [...ALGORITHM_LABELS], default: 0 }),
    ...operatorParams(0),
    ...operatorParams(1),
    ...operatorParams(2),
    ...operatorParams(3),
    p.db("gain", "Gain", { min: -60, max: 6, default: -6 }),
  ],

  create(ctx, io): DeviceInstance {
    const outGain = ctx.createGain();
    outGain.connect(io.out);

    // Live values the NEXT note-on reads. Mid-note changes shape the next
    // note, the same contract `core.pluck` documents — per-voice rebinding
    // would mean re-creating the whole voice graph on every knob move, and
    // with four operators that is four oscillators mid-flight.
    let algorithmIndex = 0;
    const ops: OperatorSettings[] = DEFAULTS.map((d) => ({ ...d }));

    const voices: Voice[] = [];

    const forget = (voice: Voice): void => {
      const i = voices.indexOf(voice);
      if (i >= 0) voices.splice(i, 1);
    };

    /** Release (or steal) a voice: every operator's envelope falls together,
     *  and the oscillators stop once the slowest of them has. */
    const fadeOut = (voice: Voice, when: number, fadeS: number): void => {
      if (voice.releasedAt !== null || voice.ended) return;
      voice.releasedAt = when;
      const tau = Math.max(0.001, fadeS) / 3;
      for (const node of voice.operators) {
        node.env.gain.cancelScheduledValues(when);
        node.env.gain.setTargetAtTime(0, when, tau);
      }
      const stopAt = when + Math.max(0.01, fadeS) * 4;
      for (const node of voice.operators) node.osc.stop(stopAt);
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
        if (localId === "algorithm") {
          handle.bindMessage((v) => void (algorithmIndex = v));
          return;
        }
        for (let op = 0; op < OPERATOR_COUNT; op++) {
          const ids = operatorParamIds(op);
          const settings = ops[op];
          if (settings === undefined) continue;
          if (localId === ids.on) handle.bindMessage((v) => void (settings.on = v));
          else if (localId === ids.wave) handle.bindMessage((v) => void (settings.wave = v));
          else if (localId === ids.coarse) handle.bindMessage((v) => void (settings.coarse = v));
          else if (localId === ids.fine) handle.bindMessage((v) => void (settings.fine = v));
          else if (localId === ids.level) handle.bindMessage((v) => void (settings.level = v));
          else if (localId === ids.attack) handle.bindMessage((v) => void (settings.attack = v));
          else if (localId === ids.decay) handle.bindMessage((v) => void (settings.decay = v));
          else if (localId === ids.sustain) handle.bindMessage((v) => void (settings.sustain = v));
          else if (localId === ids.release) handle.bindMessage((v) => void (settings.release = v));
        }
      },

      noteOn: (pitch, vel, when) => {
        const at = Math.max(when, ctx.currentTime);
        const algorithm = algorithmAt(algorithmIndex);

        // Retrigger on the same pitch releases the ringing voice, and the
        // choked voice stays listed until ITS note-off claims it.
        for (const voice of voices) {
          if (voice.pitch === pitch && voice.releasedAt === null) fadeOut(voice, at, voice.releaseS);
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
        const nodes: OperatorNodes[] = [];
        const oscByOp = new Array<OscillatorNode | null>(OPERATOR_COUNT).fill(null);
        const envByOp = new Array<GainNode | null>(OPERATOR_COUNT).fill(null);
        let longestRelease = 0;
        let anyCarrier = false;

        // Build carriers first (the reverse of `buildOrder`), so a modulator
        // always finds the `frequency` param it has to reach already made.
        const order = [...buildOrder(algorithm)].reverse();
        for (const op of order) {
          const settings = ops[op];
          if (settings === undefined || settings.on < 0.5) continue;
          const target = algorithm.targets[op] ?? OUT;
          // A modulator whose target is switched off has nothing to modulate;
          // building it would be a node running into a disconnected gain.
          if (target !== OUT && envByOp[target] === null) continue;

          const ratio = Math.max(0.01, settings.coarse + settings.fine / 100);
          const opHz = hz * ratio;

          const osc = ctx.createOscillator();
          osc.type = WAVE_TYPES[Math.round(settings.wave)] ?? "sine";
          osc.frequency.value = opHz;

          const env = ctx.createGain();
          const level = Math.max(0, Math.min(100, settings.level)) / 100;
          // A carrier's peak is loudness — squared, so the knob's lower half
          // does the fine work an ear wants there. A modulator's peak is
          // deviation in Hz: index × its OWN frequency, the textbook
          // definition, which is what keeps brightness constant across the
          // keyboard.
          const peak =
            target === OUT
              ? dbToGain(-6) * level * level * (vel / 127)
              : level * MAX_INDEX * opHz;

          const attackS = Math.max(0.0005, settings.attack / 1000);
          const decayS = Math.max(0.001, settings.decay / 1000);
          const sustain = Math.max(0, Math.min(1, settings.sustain / 100));
          env.gain.setValueAtTime(0, at);
          env.gain.linearRampToValueAtTime(peak, at + attackS);
          env.gain.setTargetAtTime(peak * sustain, at + attackS, decayS / 3);

          osc.connect(env);
          if (target === OUT) {
            env.connect(outGain);
            anyCarrier = true;
          } else {
            // `envByOp[target]` exists (checked above), so its oscillator does
            // too — this is the FM edge itself.
            env.connect(oscByOp[target]!.frequency);
          }

          oscByOp[op] = osc;
          envByOp[op] = env;
          nodes.push({ osc, env });
          longestRelease = Math.max(longestRelease, settings.release / 1000);
        }

        // Every operator off, or every one of them a modulator of something
        // off: there is nothing to hear and nothing to schedule.
        if (!anyCarrier) {
          for (const node of nodes) {
            node.osc.disconnect();
            node.env.disconnect();
          }
          return;
        }

        const voice: Voice = {
          pitch,
          operators: nodes,
          releaseS: Math.max(0.005, longestRelease),
          releasedAt: null,
          matched: false,
          ended: false,
        };
        voices.push(voice);

        // One `onended`, on the first oscillator built — they are all stopped
        // at the same time, so any of them marks the voice done, and four
        // handlers racing to disconnect the same nodes would not.
        const first = nodes[0];
        if (first !== undefined) {
          first.osc.onended = () => {
            voice.ended = true;
            for (const node of nodes) {
              node.osc.disconnect();
              node.env.disconnect();
            }
            if (voice.matched) forget(voice);
          };
        }
        for (const node of nodes) node.osc.start(at);
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
          else fadeOut(voice, at, voice.releaseS);
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
