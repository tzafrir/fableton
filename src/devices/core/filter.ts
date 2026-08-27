// `core.filter` — the M0 audio effect (SS7/SS14, PLAN.md SS18-M0 "one filter
// effect as a definition"). A single native `BiquadFilterNode`: `type` is an
// enum, `cutoff` is Hz with the SS4 log taper, `resonance` drives `Q`.
//
// Written the way SS14's one-file playbook writes a device — `p.*` for the
// descriptors, `deviceInstance({...})` for the binding table, and
// `rampOutAndDisconnect` for the click-free teardown — so the file a future
// device author imitates goes through the harness's authoring seam rather
// than around it.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

/** `type` param value is the index into this list (SS4 "enum ... value is the index"). */
export const FILTER_TYPES = ["lowpass", "highpass", "bandpass", "notch"] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

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
  ],
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],

  create(ctx, io): DeviceInstance {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    // An owned output gain, purely so `dispose` can fade click-free (SS7
    // "Removal is the reverse, gain-ramped").
    const outGain = ctx.createGain();

    io.in.connect(filter);
    filter.connect(outGain);
    outGain.connect(io.out);

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
      },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx, also: [filter] });
      },
    });
  },
};
