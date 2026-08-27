// SS6 — the routing graph as DATA (`load-bearing`).
//
// "Routing lives in the DOCUMENT as data; a reconciler diffs document -> live
// audio graph." This file is the vocabulary both halves speak: `buildGraph`
// (src/engine/graph/build.ts) projects a `Project` into a `GraphDescription`,
// `diffGraph` compares two descriptions into a `GraphPatch`, and the
// reconciler (src/engine/graph/reconciler.ts) is the ONLY code that turns a
// patch into real `AudioNode` calls. Everything in this file must be plain
// comparable data — node and edge identity is a string derived from document
// ids, which is what makes "dynamic effect chains" a diff instead of a
// feature (SS6 "Reconciler").

import type { ChannelId, DeviceDefinitionId, DeviceInstanceId } from "./ids";

/**
 * Address of one wiring endpoint. Built ONLY by src/engine/graph/ids.ts —
 * nothing else concatenates these strings:
 *
 *   channel utility node : `chan:<ChannelId>/<util>`     (see `UtilNodeKind`)
 *   send gain            : `chan:<ChannelId>/send:<to>`
 *   device port          : `dev:<DeviceInstanceId>/in|out|port:<portId>`
 *   context destination  : `$destination`
 */
export type GraphNodeRef = string;

/** One directed connection, serialized as `<from>><to>` (see edgeId). */
export type GraphEdgeId = string;

/**
 * The utility nodes every channel owns, in signal order (SS6 "Signal flow
 * inside a channel"):
 *
 *   input -> [chain devices] -> postfx -> mute -> vol -> pan -> post
 *
 * - `input`  — GainNode summing the channel's sources: its instrument, its
 *              member channels (groups), and incoming sends (returns).
 * - `postfx` — unity GainNode marking the post-chain point, so the SS6
 *              `postFx` sidechain tap and the pre-fader send tap have a
 *              stable node regardless of chain length. Pre-fader sends tap
 *              MUTE's output (post-mute) so muting a channel silences its
 *              sends too.
 * - `mute`   — GainNode driven by solo-in-place (SS6 "Solo / mute": "the
 *              engine applies it via per-channel mute gains"). Never bound
 *              to a param; the engine writes it directly.
 * - `vol`    — GainNode driven by the channel's volume param (dB -> linear).
 * - `pan`    — StereoPannerNode driven by the pan param (-1..1, direct).
 * - `post`   — unity GainNode: the post-fader tap (sends, sidechain, meter)
 *              and the edge into the parent channel / destination.
 */
export type UtilNodeKind = "input" | "postfx" | "mute" | "vol" | "pan" | "post" | "send";

/** What kind of native node a utility ref instantiates. */
export type UtilNodeType = "gain" | "panner";

export interface UtilNodeSpec {
  ref: GraphNodeRef;
  type: UtilNodeType;
  kind: UtilNodeKind;
  channelId: ChannelId;
  /** `send` nodes only: the destination channel of the send. */
  sendTo?: ChannelId | undefined;
}

/** One device the graph wants mounted (SS7 lifecycle, run by the harness). */
export interface DeviceMountSpec {
  deviceId: DeviceInstanceId;
  definitionId: DeviceDefinitionId;
  channelId: ChannelId;
}

/**
 * The pure projection of a document's routing (SS6 `buildGraph(doc)`).
 * Two descriptions built from equal documents are deep-equal, and every id
 * is stable across sessions — both properties the differ relies on.
 */
export interface GraphDescription {
  /** Utility nodes keyed by ref. */
  utils: ReadonlyMap<GraphNodeRef, UtilNodeSpec>;
  /** Devices to mount, keyed by instance id. */
  mounts: ReadonlyMap<DeviceInstanceId, DeviceMountSpec>;
  /** Every connection, as `edgeId(from, to)` -> the parsed pair. */
  edges: ReadonlyMap<GraphEdgeId, { from: GraphNodeRef; to: GraphNodeRef }>;
}

/**
 * `diff(live, desired)` (SS6): what must change, in application order —
 * create / connect / disconnect / dispose. The reconciler applies ~8 ms gain
 * dips at touched channel boundaries around the rewire so chain reorders,
 * device swaps and regrouping are click-free; device disposal is deferred
 * until ramps and tails complete (the harness owns that timing).
 */
export interface GraphPatch {
  createUtils: UtilNodeSpec[];
  mountDevices: DeviceMountSpec[];
  disconnect: { from: GraphNodeRef; to: GraphNodeRef }[];
  connect: { from: GraphNodeRef; to: GraphNodeRef }[];
  unmountDevices: DeviceInstanceId[];
  disposeUtils: GraphNodeRef[];
}

/** True when the patch would change nothing. */
export function isEmptyPatch(patch: GraphPatch): boolean {
  return (
    patch.createUtils.length === 0 &&
    patch.mountDevices.length === 0 &&
    patch.disconnect.length === 0 &&
    patch.connect.length === 0 &&
    patch.unmountDevices.length === 0 &&
    patch.disposeUtils.length === 0
  );
}

/**
 * Peak/RMS for one strip, read by the UI at rAF (SS6 "Metering"). Values are
 * linear amplitude (not dB); `peak` decays in the READER, not the writer.
 * Meters are UI-only and never enter the document (SS13).
 */
export interface MeterFrame {
  peak: number;
  rms: number;
}
