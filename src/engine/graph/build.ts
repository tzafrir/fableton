// SS6 — `buildGraph(doc)`: "a pure function producing a desired graph
// description (typed nodes + edges with stable ids derived from document
// ids)". No `AudioNode` appears anywhere in this file; two calls on equal
// documents return deep-equal descriptions, which is the property the differ
// and every test in build.test.ts relies on.
//
// Per-channel signal flow (SS6, with the tap points made explicit):
//
//   source instrument ─┐
//   member channels  ──┤
//   incoming sends   ──┴─> input -> [chain] -> postfx -> mute -> vol -> pan -> post -> parent input
//                                                │        │                     │
//                                     sidechain preFx     ├─ pre-fader sends    ├─ post-fader sends
//                                     taps `input`;       │  (post-mute, so     ├─ sidechain postFader
//                                     postFx taps         │   mute silences     └─ meter tap (reconciler)
//                                     `postfx`            │   sends too)
//
// Disabled devices (`DeviceState.enabled === false`) STAY MOUNTED but are
// bypassed by the edge set — toggling enable is then a two-edge diff, not a
// mount/unmount, so it is instant and the device keeps its state (SS7).

import type { ChannelId, DeviceInstanceId, ProjectSnapshot } from "../../types";
import type {
  DeviceMountSpec,
  GraphDescription,
  GraphNodeRef,
  UtilNodeSpec,
} from "../../types/graph";
import {
  DESTINATION_REF,
  channelUtilRef,
  deviceInRef,
  deviceOutRef,
  devicePortRef,
  edgeId,
  sendRef,
} from "./ids";

interface Builder {
  utils: Map<GraphNodeRef, UtilNodeSpec>;
  mounts: Map<DeviceInstanceId, DeviceMountSpec>;
  edges: Map<string, { from: GraphNodeRef; to: GraphNodeRef }>;
}

function addUtil(b: Builder, spec: UtilNodeSpec): GraphNodeRef {
  b.utils.set(spec.ref, spec);
  return spec.ref;
}

function connect(b: Builder, from: GraphNodeRef, to: GraphNodeRef): void {
  b.edges.set(edgeId(from, to), { from, to });
}

/** The SS6 sidechain tap points, as graph refs. */
export function sidechainTapRef(channelId: ChannelId, tap: "preFx" | "postFx" | "postFader"): GraphNodeRef {
  if (tap === "preFx") return channelUtilRef(channelId, "input");
  if (tap === "postFx") return channelUtilRef(channelId, "postfx");
  return channelUtilRef(channelId, "post");
}

export function buildGraph(doc: ProjectSnapshot): GraphDescription {
  const b: Builder = { utils: new Map(), mounts: new Map(), edges: new Map() };

  for (const channelId of doc.channelOrder) {
    const channel = doc.channels[channelId];
    if (channel === undefined) continue;

    // --- utility spine -----------------------------------------------------
    const input = addUtil(b, { ref: channelUtilRef(channelId, "input"), type: "gain", kind: "input", channelId });
    const postfx = addUtil(b, { ref: channelUtilRef(channelId, "postfx"), type: "gain", kind: "postfx", channelId });
    const mute = addUtil(b, { ref: channelUtilRef(channelId, "mute"), type: "gain", kind: "mute", channelId });
    const vol = addUtil(b, { ref: channelUtilRef(channelId, "vol"), type: "gain", kind: "vol", channelId });
    const pan = addUtil(b, { ref: channelUtilRef(channelId, "pan"), type: "panner", kind: "pan", channelId });
    const post = addUtil(b, { ref: channelUtilRef(channelId, "post"), type: "gain", kind: "post", channelId });

    // --- source instrument -------------------------------------------------
    if (channel.source !== null && channel.source.kind === "instrument") {
      const device = doc.devices[channel.source.deviceId];
      if (device !== undefined) {
        b.mounts.set(device.id, { deviceId: device.id, definitionId: device.definitionId, channelId });
        // A disabled instrument stays mounted but contributes no signal.
        if (device.enabled) connect(b, deviceOutRef(device.id), input);
      }
    }

    // --- effect chain, bypassing disabled devices --------------------------
    let cursor: GraphNodeRef = input;
    for (const deviceId of channel.chain) {
      const device = doc.devices[deviceId];
      if (device === undefined) continue;
      b.mounts.set(device.id, { deviceId: device.id, definitionId: device.definitionId, channelId });
      if (!device.enabled) continue; // mounted, silent, out of the path
      connect(b, cursor, deviceInRef(device.id));
      cursor = deviceOutRef(device.id);
    }
    connect(b, cursor, postfx);
    connect(b, postfx, mute);
    connect(b, mute, vol);
    connect(b, vol, pan);
    connect(b, pan, post);

    // --- output ------------------------------------------------------------
    if (channel.role === "master" || channel.output === null) {
      connect(b, post, DESTINATION_REF);
    } else if (doc.channels[channel.output] !== undefined) {
      connect(b, post, channelUtilRef(channel.output, "input"));
    } else {
      // Dangling output (invalid doc survived validation): fail audible-safe.
      connect(b, post, DESTINATION_REF);
    }

    // --- sends -------------------------------------------------------------
    for (const send of channel.sends) {
      if (doc.channels[send.to] === undefined) continue;
      const gain = addUtil(b, {
        ref: sendRef(channelId, send.to),
        type: "gain",
        kind: "send",
        channelId,
        sendTo: send.to,
      });
      // SS6: taps at pre-fader (post-chain) or post-fader. `pre` taps the
      // MUTE output so a muted channel's sends fall silent with it.
      connect(b, send.tap === "pre" ? mute : post, gain);
      connect(b, gain, channelUtilRef(send.to, "input"));
    }
  }

  // --- sidechain edges (SS6: explicit data, never a device hack) -----------
  for (const edge of doc.sidechains) {
    const device = doc.devices[edge.to.device];
    if (device === undefined) continue;
    if (doc.channels[edge.from.channel] === undefined) continue;
    if (!b.mounts.has(device.id)) continue;
    connect(b, sidechainTapRef(edge.from.channel, edge.from.tap), devicePortRef(device.id, edge.to.port));
  }

  return { utils: b.utils, mounts: b.mounts, edges: b.edges };
}
