// `core.eq8` — eight bands of parametric EQ, with a curve you drag.
//
// Eight native `BiquadFilterNode`s in series, and they STAY in series: a
// disabled band is not unwired, it is set to a peaking filter at 0 dB, whose
// numerator and denominator coefficients are identical — exactly unity, and
// therefore a true bypass. That is worth the sentence because the obvious
// implementation (disconnect the node) has to rewire a live signal path every
// time a band is toggled, which clicks; this does not, and it keeps the
// device's graph fixed for its whole life.
//
// The panel is not a grid of knobs (SS5's default) but a picture of the
// curve over the live spectrum — see `DeviceDefinition.editor` and
// src/app/panels/devices/Eq8Editor.tsx. The curve it draws comes from
// ./eq8/response.ts, a pure function of the same numbers the biquads get,
// not from the nodes: the panel has to draw before audio is booted, and for
// a channel whose devices are not mounted.

import type { DeviceDefinition, DeviceInstance, ParamDescriptor, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { writeAudioParam } from "../../params/handle";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { BAND_TYPE_LABELS, BIQUAD_TYPE, Q_DB_TYPES, bandTypeFromIndex } from "./eq8/response";

/** How many bands. Named because the panel, the params and the response all
 *  have to agree on it. */
export const EQ8_BAND_COUNT = 8;

/** Where the bands sit before anyone touches them: an octave-ish apart across
 *  the audible range, so the eight handles start out spread rather than
 *  stacked on top of each other. */
export const DEFAULT_BAND_FREQ = [60, 140, 320, 700, 1500, 3200, 7000, 14000];

/** The types the eight bands are born as. The outer two are the cut filters
 *  every EQ puts at its ends; the rest are bells. */
const DEFAULT_BAND_TYPE = [0, 2, 2, 2, 2, 2, 2, 5];

/** Bands 1 and 8 (the cuts) start OFF: a low cut is a decision, not a
 *  default, and one silently applied at 60 Hz would be a mystery. */
const DEFAULT_BAND_ENABLED = [0, 1, 1, 1, 1, 1, 1, 0];

export const BAND_GAIN_MIN_DB = -18;
export const BAND_GAIN_MAX_DB = 18;
export const BAND_Q_MIN = 0.1;
export const BAND_Q_MAX = 18;
export const BAND_FREQ_MIN_HZ = 20;
export const BAND_FREQ_MAX_HZ = 20000;

/** Device-local param ids for band `index` (0-based). PUBLIC API, like every
 *  param id — the panel builds the same strings to find its handles. */
export function bandParamIds(index: number): {
  on: string;
  type: string;
  freq: string;
  gain: string;
  q: string;
} {
  const n = index + 1;
  return {
    on: `b${n}on`,
    type: `b${n}type`,
    freq: `b${n}freq`,
    gain: `b${n}gain`,
    q: `b${n}q`,
  };
}

function bandParams(index: number): ParamDescriptor[] {
  const ids = bandParamIds(index);
  const n = index + 1;
  return [
    p.toggle(ids.on, `${n} On`, { default: DEFAULT_BAND_ENABLED[index] === 1 }),
    p.enum(ids.type, `${n} Type`, {
      labels: [...BAND_TYPE_LABELS],
      default: DEFAULT_BAND_TYPE[index] ?? 2,
    }),
    p.hz(ids.freq, `${n} Freq`, {
      min: BAND_FREQ_MIN_HZ,
      max: BAND_FREQ_MAX_HZ,
      default: DEFAULT_BAND_FREQ[index] ?? 1000,
    }),
    p.db(ids.gain, `${n} Gain`, {
      min: BAND_GAIN_MIN_DB,
      max: BAND_GAIN_MAX_DB,
      default: 0,
      bipolar: true,
    }),
    // Log taper: the useful half of a Q range is all below 2, and a linear
    // knob spends most of its travel between "very narrow" and "narrower".
    p.continuous(ids.q, `${n} Q`, {
      min: BAND_Q_MIN,
      max: BAND_Q_MAX,
      default: 0.7,
      taper: "log",
    }),
  ];
}

export const Eq8: DeviceDefinition = {
  id: "core.eq8",
  version: 1,
  kind: "audioEffect",
  label: "EQ Eight",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  editor: "eq8",
  params: [
    ...Array.from({ length: EQ8_BAND_COUNT }, (_, i) => bandParams(i)).flat(),
    p.db("output", "Output", { min: -24, max: 24, default: 0 }),
  ],

  create(ctx, io): DeviceInstance {
    const filters: BiquadFilterNode[] = [];
    const outGain = ctx.createGain();

    // The band's own state, mirrored here because four of the five params
    // interact: a disabled band ignores its type and its gain, and the units
    // `Q` is written in depend on the type (see `applyQ`).
    const enabled = [...DEFAULT_BAND_ENABLED];
    const types = [...DEFAULT_BAND_TYPE];
    const gains = new Array<number>(EQ8_BAND_COUNT).fill(0);
    const qs = new Array<number>(EQ8_BAND_COUNT).fill(0.7);

    let cursor: AudioNode = io.in;
    for (let i = 0; i < EQ8_BAND_COUNT; i++) {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = DEFAULT_BAND_FREQ[i] ?? 1000;
      filter.Q.value = 0.7;
      filter.gain.value = 0;
      cursor.connect(filter);
      cursor = filter;
      filters.push(filter);
    }
    cursor.connect(outGain);
    outGain.connect(io.out);

    /**
     * Pushes band `i`'s type and gain into its node.
     *
     * `type` is a plain JS property with no scheduling primitive, so it
     * applies at the next render quantum rather than at `when` (see
     * `ParamHandle.bindMessage`). An automation lane on a band's TYPE would
     * therefore land up to a look-ahead early — which is the honest cost of
     * automating a discrete filter topology, and the reason `gain`, `freq`
     * and `Q` (the three anyone actually automates) are all ramped
     * `AudioParam`s instead.
     */
    function apply(i: number, when: Seconds): void {
      const filter = filters[i];
      if (filter === undefined) return;
      const on = (enabled[i] ?? 0) >= 0.5;
      // Off -> peaking at 0 dB, which is unity by construction.
      filter.type = on ? BIQUAD_TYPE[bandTypeFromIndex(types[i] ?? 2)] : "peaking";
      writeAudioParam(filter.gain, on ? (gains[i] ?? 0) : 0, when, 12);
      applyQ(i, when);
    }

    /**
     * Pushes band `i`'s Q into its node, in the units that node wants.
     *
     * `Q` is a QUALITY FACTOR everywhere the user can see it — the param, the
     * readout, the drawn curve — but Web Audio reads `BiquadFilterNode.Q` as
     * DECIBELS on `lowpass`/`highpass`. This is the one place that difference
     * lives, so nothing above it has to know the type before it can read the
     * number. (A disabled band is a peaking filter at 0 dB, which is unity
     * whatever its Q, so it takes the plain value.)
     */
    function applyQ(i: number, when: Seconds): void {
      const filter = filters[i];
      if (filter === undefined) return;
      const q = Math.max(1e-4, qs[i] ?? 0.7);
      const on = (enabled[i] ?? 0) >= 0.5;
      const type = bandTypeFromIndex(types[i] ?? 2);
      const asDb = on && Q_DB_TYPES.has(type);
      writeAudioParam(filter.Q, asDb ? 20 * Math.log10(q) : q, when, 12);
    }

    const audioParams: Record<string, AudioParam> = {};
    const messageParams: Record<string, (v: number, when: Seconds) => void> = {};
    for (let i = 0; i < EQ8_BAND_COUNT; i++) {
      const ids = bandParamIds(i);
      const filter = filters[i]!;
      audioParams[ids.freq] = filter.frequency;
      messageParams[ids.q] = (v, when) => {
        qs[i] = v;
        applyQ(i, when);
      };
      messageParams[ids.on] = (v, when) => {
        enabled[i] = v;
        apply(i, when);
      };
      messageParams[ids.type] = (v, when) => {
        types[i] = v;
        apply(i, when);
      };
      messageParams[ids.gain] = (v, when) => {
        gains[i] = v;
        apply(i, when);
      };
    }

    return deviceInstance({
      audioParams,
      messageParams,
      gainParams: { output: outGain },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx, also: filters });
      },
    });
  },
};
