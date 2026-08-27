// `core.stereo-delay` — SS14's own playbook example, implemented as written:
// "Here is the entire cost of a stereo delay." Split L/R, independent delay
// times, one shared feedback loop, equal-power wet/dry mix.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { NOTE_DIVISION_LABELS, divisionIndex, divisionSeconds } from "./noteDivisions";

export const StereoDelay: DeviceDefinition = {
  id: "core.stereo-delay",
  version: 1,
  kind: "audioEffect",
  label: "Stereo Delay",
  // The input port is declared STEREO on purpose (SS7 `PortSpec.channels`):
  // `io.in` feeds a ChannelSplitter, and a splitter's up-mix is DISCRETE — a
  // mono source (the Pluck today, an SS2 audio track later) would land on
  // channel 0 with silence on channel 1, so `dr` would never see signal and
  // every repeat would be hard-panned left. `createDeviceIO` honours this by
  // giving the port node `channelCount 2 / explicit / speakers`, which up-mixes
  // mono to L = R before the split.
  audioIn: [{ id: "in", channels: 2 }],
  audioOut: [{ id: "out" }],
  params: [
    // SS8 sync: with `sync` on, the two DIVISION enums drive the delay and
    // the ms times are ignored — a delay written as "1/8 dotted" stays that
    // note value at any tempo, which is the whole point of syncing it.
    p.toggle("sync", "Sync"),
    p.enum("divL", "Div L", { labels: [...NOTE_DIVISION_LABELS], default: divisionIndex("1/8") }),
    p.enum("divR", "Div R", { labels: [...NOTE_DIVISION_LABELS], default: divisionIndex("1/8.") }),
    p.time("timeL", "Time L", { min: 1, max: 2000, default: 250 }),
    p.time("timeR", "Time R", { min: 1, max: 2000, default: 375 }),
    p.pct("feedback", "Feedback", { default: 35, max: 95 }),
    p.pct("mix", "Mix", { default: 25 }),
  ],

  create(ctx, io, services): DeviceInstance {
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

    // Live state the time writer reads. A delay time is either the ms param
    // or the division, and which one is a THIRD param — so the write has to
    // be assembled here rather than bound 1:1 to an AudioParam.
    let sync = false;
    const divisions = { L: 0, R: 0 };
    const millis = { L: 250, R: 375 };

    /** Changing a delay time re-pitches whatever is still in the line, so the
     *  write is smoothed rather than stepped — 30 ms is short enough to feel
     *  immediate and long enough not to click. */
    const writeTime = (side: "L" | "R", when: number): void => {
      const seconds = sync
        ? divisionSeconds(divisions[side], services.tempo.secondsPerBeat())
        : millis[side] / 1000;
      const param = side === "L" ? dl.delayTime : dr.delayTime;
      param.setTargetAtTime(Math.min(2, Math.max(0.001, seconds)), Math.max(0, when), 0.03);
    };

    const writeBoth = (when = 0): void => {
      writeTime("L", when);
      writeTime("R", when);
    };

    // A tempo change moves a synced delay to the new beat length; an unsynced
    // one must not move at all.
    const unsubscribeTempo = services.tempo.onChange(() => {
      if (sync) writeBoth();
    });

    return deviceInstance({
      gainParams: { feedback: fb, mix: [wet, dry] }, // mix = equal-power pair
      connectParam: (localId, handle) => {
        if (localId === "sync") {
          handle.bindMessage((v, when) => {
            sync = v >= 0.5;
            writeBoth(when);
          });
        } else if (localId === "divL" || localId === "divR") {
          const side = localId === "divL" ? "L" : "R";
          handle.bindMessage((v, when) => {
            divisions[side] = v;
            if (sync) writeTime(side, when);
          });
        } else if (localId === "timeL" || localId === "timeR") {
          const side = localId === "timeL" ? "L" : "R";
          handle.bindMessage((v, when) => {
            millis[side] = v;
            if (!sync) writeTime(side, when);
          });
        }
      },
      dispose: (when?: Seconds): void => {
        unsubscribeTempo();
        rampOutAndDisconnect(when, [dry, wet], { context: ctx, also: [split, merge, dl, dr, fb] });
      },
    });
  },
};
