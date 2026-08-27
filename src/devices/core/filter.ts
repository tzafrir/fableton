// `core.filter` — the M0 audio effect (SS7/SS14, PLAN.md SS18-M0 "one filter
// effect as a definition"), grown into an auto-filter. A native
// `BiquadFilterNode`: `type` is an enum, `cutoff` is Hz with the SS4 log
// taper, `resonance` drives `Q` — plus an LFO on `detune`, whose rate can be
// free-running in Hz or locked to a note division at the song tempo (SS8).
//
// Written the way SS14's one-file playbook writes a device — `p.*` for the
// descriptors, `deviceInstance({...})` for the binding table, and
// `rampOutAndDisconnect` for the click-free teardown — so the file a future
// device author imitates goes through the harness's authoring seam rather
// than around it.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { NOTE_DIVISION_LABELS, divisionHz, divisionIndex } from "./noteDivisions";

/** `type` param value is the index into this list (SS4 "enum ... value is the index"). */
export const FILTER_TYPES = ["lowpass", "highpass", "bandpass", "notch"] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

/** LFO waveforms, as `OscillatorType`s the node speaks natively. */
export const LFO_SHAPES = ["sine", "triangle", "square", "sawtooth"] as const;
export type LfoShape = (typeof LFO_SHAPES)[number];

export function lfoShapeFromIndex(index: number): LfoShape {
  const clamped = Math.min(LFO_SHAPES.length - 1, Math.max(0, Math.round(index)));
  return LFO_SHAPES[clamped] ?? "sine";
}

export function filterTypeFromIndex(index: number): FilterType {
  const clamped = Math.min(FILTER_TYPES.length - 1, Math.max(0, Math.round(index)));
  return FILTER_TYPES[clamped] ?? "lowpass";
}

export const Filter: DeviceDefinition = {
  id: "core.filter",
  version: 1,
  kind: "audioEffect",
  label: "Filter",
  params: [
    p.enum("type", "Type", { labels: [...FILTER_TYPES] }),
    p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1000 }),
    p.continuous("resonance", "Resonance", { min: 0.1, max: 24, default: 0.707, unit: "Q" }),
    // LFO — this is what makes the device an auto-filter. Depth is in
    // SEMITONES because it drives `detune` (cents), so a sweep covers the
    // same musical interval wherever the cutoff sits; a depth in Hz would be
    // an octave at 100 Hz and inaudible at 10 kHz.
    p.enum("lfoShape", "LFO Shape", { labels: [...LFO_SHAPES] }),
    p.st("lfoDepth", "LFO Depth", { min: 0, max: 48, default: 0 }),
    p.toggle("lfoSync", "LFO Sync"),
    p.enum("lfoDiv", "LFO Div", { labels: [...NOTE_DIVISION_LABELS], default: divisionIndex("1/4") }),
    p.hz("lfoRate", "LFO Rate", { min: 0.01, max: 40, default: 1 }),
  ],
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],

  create(ctx, io, services): DeviceInstance {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    // An owned output gain, purely so `dispose` can fade click-free (SS7
    // "Removal is the reverse, gain-ramped").
    const outGain = ctx.createGain();

    io.in.connect(filter);
    filter.connect(outGain);
    outGain.connect(io.out);

    // The LFO runs ALWAYS, at zero depth until asked for: starting and
    // stopping an OscillatorNode per depth change would mean a new node every
    // time (they are one-shot), and its phase would jump on each restart.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 1;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    // `detune` is in CENTS, so the modulation is logarithmic — musically
    // even across the whole cutoff range, which modulating `frequency` in Hz
    // is not.
    lfoDepth.connect(filter.detune);
    lfo.start();

    let lfoSync = false;
    let lfoDiv = 0;
    let lfoHz = 1;

    const writeRate = (when: number): void => {
      const hz = lfoSync ? divisionHz(lfoDiv, services.tempo.secondsPerBeat()) : lfoHz;
      lfo.frequency.setTargetAtTime(Math.min(200, Math.max(0.001, hz)), Math.max(0, when), 0.01);
    };
    const unsubscribeTempo = services.tempo.onChange(() => {
      if (lfoSync) writeRate(0);
    });

    return deviceInstance({
      audioParams: { cutoff: filter.frequency, resonance: filter.Q },
      messageParams: {
        // `BiquadFilterType` is a plain string property, not an AudioParam —
        // no ramp semantics exist for it, and no scheduling primitive either.
        // So this binding deliberately IGNORES `bindMessage`'s `when` and
        // applies at the next render quantum: with a 200 ms look-ahead (SS12)
        // an SS11 automation write timestamped for the far edge of the window
        // therefore lands up to that window EARLY. Documented rather than
        // faked: a wall-clock `setTimeout` shim would drift against
        // `ctx.currentTime` the moment the context is suspended or offline,
        // which is a worse failure than a known-early enum switch. When M3
        // needs sample-accurate filter-type changes, the answer is a worklet
        // (or a crossfade between two biquads), not a timer here.
        type: (value: number): void => {
          filter.type = filterTypeFromIndex(value);
        },
        lfoShape: (value: number): void => {
          lfo.type = lfoShapeFromIndex(value);
        },
        // Semitones -> cents, the unit `detune` speaks.
        lfoDepth: (value: number, when: number): void => {
          lfoDepth.gain.setTargetAtTime(value * 100, Math.max(0, when), 0.02);
        },
        lfoSync: (value: number, when: number): void => {
          lfoSync = value >= 0.5;
          writeRate(when);
        },
        lfoDiv: (value: number, when: number): void => {
          lfoDiv = value;
          if (lfoSync) writeRate(when);
        },
        lfoRate: (value: number, when: number): void => {
          lfoHz = value;
          if (!lfoSync) writeRate(when);
        },
      },
      dispose: (when?: Seconds): void => {
        unsubscribeTempo();
        try {
          lfo.stop((when ?? ctx.currentTime) + 0.1);
        } catch {
          // Already stopped (a second dispose, or a context torn down).
        }
        rampOutAndDisconnect(when, [outGain], { context: ctx, also: [filter, lfo, lfoDepth] });
      },
    });
  },
};
