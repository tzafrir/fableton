// `core.stereo-delay` — SS14's own playbook example, implemented as written:
// "Here is the entire cost of a stereo delay." Split L/R, independent delay
// times, one shared feedback loop, equal-power wet/dry mix.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, msParam, rampOutAndDisconnect } from "../harness/deviceInstance";

export const StereoDelay: DeviceDefinition = {
  id: "core.stereo-delay",
  version: 1,
  kind: "audioEffect",
  label: "Stereo Delay",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    p.time("timeL", "Time L", { min: 1, max: 2000, default: 250 }),
    p.time("timeR", "Time R", { min: 1, max: 2000, default: 375 }),
    p.pct("feedback", "Feedback", { default: 35, max: 95 }),
    p.pct("mix", "Mix", { default: 25 }),
  ],

  create(ctx, io): DeviceInstance {
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(2);
    const dr = ctx.createDelay(2);
    const fb = ctx.createGain();
    const wet = ctx.createGain();
    const dry = ctx.createGain();

    io.in.connect(dry);
    dry.connect(io.out);
    io.in.connect(split);
    split.connect(dl, 0);
    split.connect(dr, 1);
    dl.connect(merge, 0, 0);
    dr.connect(merge, 0, 1);
    merge.connect(fb);
    fb.connect(split); // shared feedback
    merge.connect(wet);
    wet.connect(io.out);

    return deviceInstance({
      // ms -> s conversion via the harness's scaler (SS14 "+ ms→s scaler").
      scaledParams: { timeL: msParam(dl.delayTime), timeR: msParam(dr.delayTime) },
      gainParams: { feedback: fb, mix: [wet, dry] }, // mix = equal-power pair
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [dry, wet], { context: ctx, also: [split, merge, dl, dr, fb] });
      },
    });
  },
};
