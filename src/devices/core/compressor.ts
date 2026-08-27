// `core.compressor` — the SS18-M4 "compressor with SC": the device whose
// `{ id: 'sc', optional: true }` input port is what lights up the SS6
// routing UI's "Audio From" picker. DSP is a two-input worklet
// (src/worklets/compressor-processor.ts); the kernel itself unit-tests
// headlessly (SS15).

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { formatDb } from "../../params/text";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { COMPRESSOR_PROCESSOR_NAME } from "./compressor/processorName";
import compressorWorkletUrl from "../../worklets/compressor-processor.ts?worker&url";

export const Compressor: DeviceDefinition = {
  id: "core.compressor",
  version: 1,
  kind: "audioEffect",
  label: "Compressor",
  audioIn: [
    { id: "in" },
    { id: "sc", label: "Sidechain", optional: true },
  ],
  audioOut: [{ id: "out" }],
  params: [
    // Explicit `toText`: `p.db`'s generated one renders a -60 dB bottom as
    // "-inf dB" (`dbSilenceFloor`), which is right for a GAIN and wrong here —
    // a threshold at the bottom of its range means "compress everything", not
    // "silent". SS4 makes `toText` the sanctioned readout of the real value.
    p.db("threshold", "Threshold", { min: -60, max: 0, default: -24, toText: (v) => formatDb(v) }),
    p.continuous("ratio", "Ratio", { min: 1, max: 20, default: 4, unit: ":1" }),
    p.ms("attack", "Attack", { min: 0.1, max: 250, default: 5 }),
    p.ms("release", "Release", { min: 5, max: 2000, default: 120 }),
    p.db("makeup", "Makeup", { min: 0, max: 24, default: 0 }),
  ],

  async prepare(ctx): Promise<void> {
    await ctx.audioWorklet.addModule(compressorWorkletUrl);
  },

  create(ctx, io): DeviceInstance {
    const node = new AudioWorkletNode(ctx, COMPRESSOR_PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const outGain = ctx.createGain();

    io.in.connect(node, 0, 0);
    // The `sc` PORT node always exists (SS7: the harness owns the ports), and
    // it is connected here whether or not an SS6 edge ever feeds it — the
    // device cannot see the routing document. Which input keys the detector is
    // therefore decided inside the worklet, not by this connection; see the
    // header of src/worklets/compressor-processor.ts.
    const sc = io.inputs["sc"];
    if (sc !== undefined) sc.connect(node, 0, 1);
    /** SS6 routing truth, straight from the reconciler (see `portRouted`). */
    const postScRouted = (routed: boolean): void => {
      node.port.postMessage({ type: "scRouted", value: routed });
    };
    node.connect(outGain);
    outGain.connect(io.out);

    const param = (name: string): AudioParam => {
      const found = node.parameters.get(name);
      if (found === undefined) throw new Error(`compressor worklet lacks param ${name}`);
      return found;
    };

    return deviceInstance({
      audioParams: {
        threshold: param("threshold"),
        ratio: param("ratio"),
        makeup: param("makeup"),
      },
      scaledParams: {
        // ms descriptors bind 1:1 here — the worklet's params ARE in ms.
      },
      // SS6 -> SS7: the reconciler tells the device whether an edge actually
      // feeds its optional `sc` port. Without this the worklet can only INFER
      // it from signal presence, and a routed key that stays quiet longer than
      // its idle timeout falls back to self-keying mid-song.
      portRouted: (portId, routed) => {
        if (portId === "sc") postScRouted(routed);
      },
      connectParam: (localId, handle) => {
        if (localId === "attack") handle.bindAudioParam(param("attack"));
        else if (localId === "release") handle.bindAudioParam(param("release"));
      },
      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx, also: [node] });
      },
    });
  },
};
