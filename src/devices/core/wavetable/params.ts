// Every param `core.wavetable` declares, in one place.
//
// Ninety of them is a lot, and that is the point of this file: the device
// (../wavetable.ts), the worklet (../../../worklets/wavetable-processor.ts)
// and the editor all need the same names, ranges and defaults, and three
// hand-kept lists of ninety entries would drift within a week. So the list is
// written once as `ParamDescriptor`s and the worklet's `AudioParamDescriptor`s
// are DERIVED from it — a range typed here is the range the DSP clamps to,
// with no second copy to forget.
//
// Two params are deliberately not `AudioParam`s: `aTable` and `bTable`. A
// table is megabytes of samples that the main thread builds and posts (see
// ../wavetable.ts), so its param has to run through a message anyway, and
// automating a table swap at audio rate is not a thing anyone wants.

import type { ParamDescriptor } from "../../../types";
import { p } from "../../../params/descriptors";
import { FILTER_ROUTINGS, FILTER_TYPES } from "./svf";
import { LFO_SHAPES } from "./lfo";
import { MOD_PARAM_IDS, MOD_SOURCES, MOD_TARGETS, modParamLabel } from "./matrix";
import { WAVETABLE_LABELS } from "./tables";

/** The two oscillators, by param prefix. */
export const OSC_PREFIXES = ["a", "b"] as const;
export const OSC_NAMES = ["Osc A", "Osc B"] as const;

export interface OscParamIds {
  on: string;
  table: string;
  pos: string;
  coarse: string;
  fine: string;
  level: string;
  pan: string;
}

export function oscParamIds(osc: number): OscParamIds {
  const x = OSC_PREFIXES[osc] ?? "a";
  return {
    on: `${x}On`,
    table: `${x}Table`,
    pos: `${x}Pos`,
    coarse: `${x}Coarse`,
    fine: `${x}Fine`,
    level: `${x}Level`,
    pan: `${x}Pan`,
  };
}

export interface FilterParamIds {
  on: string;
  type: string;
  cutoff: string;
  res: string;
  drive: string;
  key: string;
}

export function filterParamIds(index: number): FilterParamIds {
  const n = index === 1 ? "f2" : "f1";
  return {
    on: `${n}On`,
    type: `${n}Type`,
    cutoff: `${n}Cutoff`,
    res: `${n}Res`,
    drive: `${n}Drive`,
    key: `${n}Key`,
  };
}

/** The three envelopes: 0 is the amp envelope, 1 and 2 are matrix sources. */
export const ENV_PREFIXES = ["amp", "env2", "env3"] as const;
export const ENV_NAMES = ["Amp", "Env 2", "Env 3"] as const;

export interface EnvParamIds {
  attack: string;
  decay: string;
  sustain: string;
  release: string;
}

export function envParamIds(env: number): EnvParamIds {
  const x = ENV_PREFIXES[env] ?? "amp";
  return {
    attack: `${x}Attack`,
    decay: `${x}Decay`,
    sustain: `${x}Sustain`,
    release: `${x}Release`,
  };
}

export interface LfoParamIds {
  shape: string;
  rate: string;
  retrig: string;
}

export function lfoParamIds(lfo: number): LfoParamIds {
  const n = lfo === 1 ? "lfo2" : "lfo1";
  return { shape: `${n}Shape`, rate: `${n}Rate`, retrig: `${n}Retrig` };
}

/** Params the device sends by message rather than binding to an `AudioParam`. */
export const MESSAGE_PARAM_IDS: readonly string[] = [oscParamIds(0).table, oscParamIds(1).table];

interface OscDefaults {
  on: number;
  table: number;
  pos: number;
  coarse: number;
  fine: number;
  level: number;
  pan: number;
}

/**
 * Osc A on and plain, Osc B off but parked somewhere useful — an octave down,
 * seven cents sharp, on a different table. Switching B on is then one click
 * from a fatter version of the same patch rather than one click from a
 * unison doubling that sounds like nothing changed.
 */
const OSC_DEFAULTS: readonly OscDefaults[] = [
  { on: 1, table: 0, pos: 0, coarse: 0, fine: 0, level: 100, pan: 0 },
  { on: 0, table: 1, pos: 30, coarse: -12, fine: 7, level: 100, pan: 0 },
];

interface FilterDefaults {
  on: number;
  type: number;
  cutoff: number;
  res: number;
  drive: number;
  key: number;
}

const FILTER_DEFAULTS: readonly FilterDefaults[] = [
  { on: 1, type: 1, cutoff: 4000, res: 15, drive: 0, key: 0 },
  { on: 0, type: 2, cutoff: 400, res: 0, drive: 0, key: 0 },
];

interface EnvDefaults {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

const ENV_DEFAULTS: readonly EnvDefaults[] = [
  { attack: 4, decay: 800, sustain: 70, release: 300 },
  { attack: 2, decay: 400, sustain: 0, release: 200 },
  { attack: 60, decay: 1500, sustain: 40, release: 600 },
];

const LFO_DEFAULTS = [
  { shape: 0, rate: 2, retrig: 1 },
  { shape: 1, rate: 0.5, retrig: 1 },
] as const;

function oscParams(osc: number): ParamDescriptor[] {
  const ids = oscParamIds(osc);
  const name = OSC_NAMES[osc] ?? "Osc A";
  const d = OSC_DEFAULTS[osc] ?? OSC_DEFAULTS[0]!;
  return [
    p.toggle(ids.on, `${name} On`, { default: d.on }),
    p.enum(ids.table, `${name} Table`, { labels: [...WAVETABLE_LABELS], default: d.table }),
    p.pct(ids.pos, `${name} Position`, { default: d.pos }),
    // Integers, both: a semitone is a musical choice and a cent is a detune,
    // and neither is something a mouse should be able to land between.
    p.stepped(ids.coarse, `${name} Coarse`, {
      min: -24,
      max: 24,
      step: 1,
      default: d.coarse,
      unit: "st",
      bipolar: true,
    }),
    p.stepped(ids.fine, `${name} Fine`, {
      min: -50,
      max: 50,
      step: 1,
      default: d.fine,
      unit: "ct",
      bipolar: true,
    }),
    p.pct(ids.level, `${name} Level`, { default: d.level }),
    p.pan(ids.pan, `${name} Pan`, { default: d.pan }),
  ];
}

function filterParams(index: number): ParamDescriptor[] {
  const ids = filterParamIds(index);
  const name = `Filter ${String(index + 1)}`;
  const d = FILTER_DEFAULTS[index] ?? FILTER_DEFAULTS[0]!;
  return [
    p.toggle(ids.on, `${name} On`, { default: d.on }),
    p.enum(ids.type, `${name} Type`, { labels: [...FILTER_TYPES], default: d.type }),
    p.hz(ids.cutoff, `${name} Cutoff`, { min: 20, max: 20000, default: d.cutoff }),
    p.pct(ids.res, `${name} Resonance`, { default: d.res }),
    p.db(ids.drive, `${name} Drive`, { min: 0, max: 24, default: d.drive }),
    // Keytracking: at 100% the cutoff follows the keyboard semitone for
    // semitone, so a patch keeps its brightness up the octaves instead of
    // going dull the moment the fundamental passes the cutoff.
    p.pct(ids.key, `${name} Key`, { default: d.key }),
  ];
}

function envParams(env: number): ParamDescriptor[] {
  const ids = envParamIds(env);
  const name = ENV_NAMES[env] ?? "Amp";
  const d = ENV_DEFAULTS[env] ?? ENV_DEFAULTS[0]!;
  return [
    p.ms(ids.attack, `${name} Attack`, { min: 0.5, max: 8000, default: d.attack }),
    p.ms(ids.decay, `${name} Decay`, { min: 1, max: 12000, default: d.decay }),
    p.pct(ids.sustain, `${name} Sustain`, { default: d.sustain }),
    p.ms(ids.release, `${name} Release`, { min: 1, max: 12000, default: d.release }),
  ];
}

function lfoParams(lfo: number): ParamDescriptor[] {
  const ids = lfoParamIds(lfo);
  const name = `LFO ${String(lfo + 1)}`;
  const d = LFO_DEFAULTS[lfo] ?? LFO_DEFAULTS[0];
  return [
    p.enum(ids.shape, `${name} Shape`, { labels: [...LFO_SHAPES], default: d.shape }),
    p.hz(ids.rate, `${name} Rate`, { min: 0.01, max: 40, default: d.rate }),
    p.toggle(ids.retrig, `${name} Retrigger`, { default: d.retrig }),
  ];
}

function matrixParams(): ParamDescriptor[] {
  const out: ParamDescriptor[] = [];
  for (let s = 0; s < MOD_SOURCES.length; s++) {
    for (let t = 0; t < MOD_TARGETS.length; t++) {
      out.push(
        p.pct(MOD_PARAM_IDS[s]![t]!, modParamLabel(s, t), {
          min: -100,
          max: 100,
          default: 0,
          bipolar: true,
        }),
      );
    }
  }
  return out;
}

/** The whole declaration, in panel order. */
export const WAVETABLE_PARAMS: readonly ParamDescriptor[] = [
  p.stepped("voices", "Voices", { min: 1, max: 16, step: 1, default: 8 }),
  p.ms("glide", "Glide", { min: 0, max: 2000, default: 0 }),
  p.enum("routing", "Routing", { labels: [...FILTER_ROUTINGS], default: 0 }),
  ...oscParams(0),
  ...oscParams(1),
  ...filterParams(0),
  ...filterParams(1),
  ...envParams(0),
  ...envParams(1),
  ...envParams(2),
  ...lfoParams(0),
  ...lfoParams(1),
  ...matrixParams(),
  p.db("gain", "Gain", { min: -60, max: 6, default: -6 }),
];

/** Ids that reach the worklet as real `AudioParam`s (fast path A, SS4). */
export const AUDIO_PARAM_IDS: readonly string[] = WAVETABLE_PARAMS.map((d) => d.id).filter(
  (id) => !MESSAGE_PARAM_IDS.includes(id),
);

/**
 * The worklet's `parameterDescriptors`, derived from the same list.
 *
 * Every one is k-rate: the modulation this instrument does at audio rate is
 * its own (the matrix, sampled per block and interpolated per sample), and a
 * knob or an automation lane moving faster than 2.7 ms is not a thing the
 * hand or the lane can produce.
 */
export function workletParameterDescriptors(): {
  name: string;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: "k-rate";
}[] {
  const audio = new Set(AUDIO_PARAM_IDS);
  return WAVETABLE_PARAMS.filter((d) => audio.has(d.id)).map((d) => ({
    name: d.id,
    defaultValue: d.defaultValue,
    minValue: d.min,
    maxValue: d.max,
    automationRate: "k-rate" as const,
  }));
}
