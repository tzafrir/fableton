// SS6 — the ONE place graph node/edge id strings are built and parsed,
// mirroring src/params/paramIds.ts for `ParamId`. Node identity derives from
// document ids so it is stable across reconciles (SS6 "typed nodes + edges
// with stable ids derived from document ids").

import type { ChannelId, DeviceInstanceId, RackChainId, RackId } from "../../types";
import type { GraphEdgeId, GraphNodeRef, UtilNodeKind } from "../../types/graph";

export const DESTINATION_REF: GraphNodeRef = "$destination";

const CHAN_PREFIX = "chan:";
const DEV_PREFIX = "dev:";
const SEND_SEGMENT = "send:";
const PORT_SEGMENT = "port:";
const RACK_PREFIX = "rack:";
const CHAIN_SEGMENT = "chain:";

/** The two ends of a rack's parallel section. */
export type RackUtil = "split" | "sum";
/** The per-chain spine inside a rack, mirroring the channel's. */
export type RackChainUtil = "mute" | "gain" | "pan";

/** `chan:<id>/input`, `chan:<id>/mute`, ... (see `UtilNodeKind`). */
export function channelUtilRef(channelId: ChannelId, kind: Exclude<UtilNodeKind, "send">): GraphNodeRef {
  return `${CHAN_PREFIX}${channelId}/${kind}`;
}

/** `chan:<from>/send:<to>` — the gain carrying `from`'s send into `to`. */
export function sendRef(from: ChannelId, to: ChannelId): GraphNodeRef {
  return `${CHAN_PREFIX}${from}/${SEND_SEGMENT}${to}`;
}

/** `rack:<rackId>/split` | `rack:<rackId>/sum`. Keyed by the RACK, not the
 *  channel: moving a rack to another channel keeps its inner wiring, so the
 *  move is an edge diff at the two ends and not a rebuild of everything
 *  inside it. */
export function rackUtilRef(rackId: RackId, util: RackUtil): GraphNodeRef {
  return `${RACK_PREFIX}${rackId}/${util}`;
}

/** `rack:<rackId>/chain:<chainId>/mute|gain|pan`. */
export function rackChainUtilRef(
  rackId: RackId,
  chainId: RackChainId,
  util: RackChainUtil,
): GraphNodeRef {
  return `${RACK_PREFIX}${rackId}/${CHAIN_SEGMENT}${chainId}/${util}`;
}

/** `dev:<id>/in` — a device's primary input port. */
export function deviceInRef(deviceId: DeviceInstanceId): GraphNodeRef {
  return `${DEV_PREFIX}${deviceId}/in`;
}

/** `dev:<id>/out` — a device's primary output port. */
export function deviceOutRef(deviceId: DeviceInstanceId): GraphNodeRef {
  return `${DEV_PREFIX}${deviceId}/out`;
}

/** `dev:<id>/port:<portId>` — a named extra input port (`'sc'`). */
export function devicePortRef(deviceId: DeviceInstanceId, portId: string): GraphNodeRef {
  return `${DEV_PREFIX}${deviceId}/${PORT_SEGMENT}${portId}`;
}

/** Edge identity: direction matters, one edge per (from, to) pair. */
export function edgeId(from: GraphNodeRef, to: GraphNodeRef): GraphEdgeId {
  return `${from}>${to}`;
}

export type ParsedNodeRef =
  | { kind: "destination" }
  | { kind: "util"; channelId: ChannelId; util: Exclude<UtilNodeKind, "send"> }
  | { kind: "send"; channelId: ChannelId; to: ChannelId }
  | { kind: "rack"; rackId: RackId; util: RackUtil }
  | { kind: "rackChain"; rackId: RackId; chainId: RackChainId; util: RackChainUtil }
  | { kind: "devicePort"; deviceId: DeviceInstanceId; port: string };

const UTIL_KINDS: ReadonlySet<string> = new Set(["input", "postfx", "mute", "vol", "pan", "post"]);
const RACK_UTILS: ReadonlySet<string> = new Set(["split", "sum"]);
const RACK_CHAIN_UTILS: ReadonlySet<string> = new Set(["mute", "gain", "pan"]);

/** Total parser for `GraphNodeRef` strings; `null` on anything malformed. */
export function parseNodeRef(ref: GraphNodeRef): ParsedNodeRef | null {
  if (ref === DESTINATION_REF) return { kind: "destination" };
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const head = ref.slice(0, slash);
  const tail = ref.slice(slash + 1);
  if (tail.length === 0) return null;

  if (head.startsWith(CHAN_PREFIX)) {
    const channelId = head.slice(CHAN_PREFIX.length);
    if (channelId.length === 0) return null;
    if (UTIL_KINDS.has(tail)) {
      return { kind: "util", channelId, util: tail as Exclude<UtilNodeKind, "send"> };
    }
    if (tail.startsWith(SEND_SEGMENT)) {
      const to = tail.slice(SEND_SEGMENT.length);
      if (to.length === 0) return null;
      return { kind: "send", channelId, to };
    }
    return null;
  }

  if (head.startsWith(RACK_PREFIX)) {
    const rackId = head.slice(RACK_PREFIX.length);
    if (rackId.length === 0) return null;
    if (RACK_UTILS.has(tail)) return { kind: "rack", rackId, util: tail as RackUtil };
    if (tail.startsWith(CHAIN_SEGMENT)) {
      const slash2 = tail.indexOf("/");
      if (slash2 < 0) return null;
      const chainId = tail.slice(CHAIN_SEGMENT.length, slash2);
      const util = tail.slice(slash2 + 1);
      if (chainId.length === 0 || !RACK_CHAIN_UTILS.has(util)) return null;
      return { kind: "rackChain", rackId, chainId, util: util as RackChainUtil };
    }
    return null;
  }

  if (head.startsWith(DEV_PREFIX)) {
    const deviceId = head.slice(DEV_PREFIX.length);
    if (deviceId.length === 0) return null;
    if (tail === "in") return { kind: "devicePort", deviceId, port: "in" };
    if (tail === "out") return { kind: "devicePort", deviceId, port: "out" };
    if (tail.startsWith(PORT_SEGMENT)) {
      const port = tail.slice(PORT_SEGMENT.length);
      if (port.length === 0) return null;
      return { kind: "devicePort", deviceId, port };
    }
    return null;
  }

  return null;
}
