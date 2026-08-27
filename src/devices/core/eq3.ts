// `core.eq3` — three-band EQ (SS18-M4 "EQ") from native biquads: low shelf,
// mid peak with a movable center, high shelf, in series.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

export const LOW_SHELF_HZ = 220;
export const HIGH_SHELF_HZ = 3200;

export const Eq3: DeviceDefinition = {
  id: "core.eq3",
  version: 1,
  kind: "audioEffect",
  label: "EQ Three",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    p.db("low", "Low", { min: -24, max: 24, default: 0 }),
    p.db("mid", "Mid", { min: -24, max: 24, default: 0 }),
    p.hz("midFreq", "Mid Freq", { min: 120, max: 7500, default: 1000 }),
    p.db("high", "High", { min: -24, max: 24, default: 0 }),
  ],

  create(ctx, io): DeviceInstance {
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = LOW_SHELF_HZ;
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 0.9;
    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = HIGH_SHELF_HZ;
    const outGain = ctx.createGain();

    io.in.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(outGain);
    outGain.connect(io.out);

    return deviceInstance({
      // Biquad `gain` params are already in dB — direct binds.
      audioParams: { low: low.gain, mid: mid.gain, midFreq: mid.frequency, high: high.gain },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx, also: [low, mid, high] });
      },
    });
  },
};
