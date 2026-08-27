// `core.gate` — a noise gate with a sidechain key (SS6/SS7).
//
// The device that makes gated reverb possible: put it after a reverb and key
// it from the channel's pre-FX tap, and the dry hit opens the door while the
// tail is what passes through it. That routing became legal in Phase 0 of
// the racks plan (`sidechainIsFeedForward`) — a same-channel key from
// `preFx` is feed-forward, not a loop.
//
// DSP is a two-input worklet (src/worklets/gate-processor.ts); the kernel
// unit-tests headlessly.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { formatDb } from "../../params/text";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { GATE_PROCESSOR_NAME } from "./gate/processorName";
import gateWorkletUrl from "../../worklets/gate-processor.ts?worker&url";

export const Gate: DeviceDefinition = {
  id: "core.gate",
  version: 1,
  kind: "audioEffect",
  label: "Gate",
  audioIn: [
    { id: "in" },
    { id: "sc", label: "Sidechain", optional: true },
  ],
  audioOut: [{ id: "out" }],
  params: [
    // Explicit `toText` for the same reason the compressor's threshold has
    // one: a threshold at the bottom of its range means "open to everything",
    // not "silent", so `p.db`'s "-inf" rendering would be a lie.
    p.db("threshold", "Threshold", { min: -80, max: 0, default: -30, toText: (v) => formatDb(v) }),
    p.ms("attack", "Attack", { min: 0.05, max: 200, default: 1 }),
    p.ms("hold", "Hold", { min: 0, max: 1000, default: 40 }),
    p.ms("release", "Release", { min: 1, max: 4000, default: 180 }),
    // "Range" on a hardware gate: how far it closes. At -60 it mutes; above
    // that it ducks, which is usually what you want on a full mix.
    p.db("floor", "Range", { min: -60, max: 0, default: -60 }),
  ],

  async prepare(ctx): Promise<void> {
    await ctx.audioWorklet.addModule(gateWorkletUrl);
  },

  create(ctx, io): DeviceInstance {
    const node = new AudioWorkletNode(ctx, GATE_PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const outGain = ctx.createGain();

    io.in.connect(node, 0, 0);
    const sc = io.inputs["sc"];
    if (sc !== undefined) sc.connect(node, 0, 1);
    const postScRouted = (routed: boolean): void => {
      node.port.postMessage({ type: "scRouted", value: routed });
    };
    node.connect(outGain);
    outGain.connect(io.out);

    const param = (name: string): AudioParam => {
      const found = node.parameters.get(name);
      if (found === undefined) throw new Error(`gate worklet lacks param ${name}`);
      return found;
    };

    return deviceInstance({
      audioParams: {
        threshold: param("threshold"),
        attack: param("attack"),
        hold: param("hold"),
        release: param("release"),
        floor: param("floor"),
      },
      // SS6 -> SS7: the reconciler is the only code that knows whether an edge
      // actually feeds the `sc` port; without this the worklet can only infer
      // it from signal presence.
      portRouted: (portId, routed) => {
        if (portId === "sc") postScRouted(routed);
      },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx, also: [node] });
      },
    });
  },
};
