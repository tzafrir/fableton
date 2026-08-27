// SS4 "Registry and id scheme" — the ONE place `ParamId` strings are built
// and parsed. Nothing else in the app concatenates these paths by hand.
//
//   device param : `chan:<ChannelId>/dev:<DeviceInstanceId>/<localId>`
//   mixer volume : `chan:<ChannelId>/vol`
//   mixer pan    : `chan:<ChannelId>/pan`
//   send amount  : `chan:<ChannelId>/send:<ChannelId>`
//
// Ids are hierarchical paths built from document ids, so they are stable
// across sessions, survive reordering, and serialize into automation lanes
// and MIDI mappings as plain strings.

import type { ChannelId, DeviceInstanceId, ParamId } from "../types";
import type { ParamDescriptor } from "../types";

/** Path segment separator. Segments themselves may never contain it. */
export const PARAM_PATH_SEPARATOR = "/";

const CHANNEL_PREFIX = "chan:";
const DEVICE_PREFIX = "dev:";
const SEND_PREFIX = "send:";

/** Leaf segment for a channel's volume param. */
export const VOLUME_LEAF = "vol";
/** Leaf segment for a channel's pan param. */
export const PAN_LEAF = "pan";

function assertSegment(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ParamId: ${what} must be a non-empty string`);
  }
  if (value.includes(PARAM_PATH_SEPARATOR)) {
    throw new Error(
      `ParamId: ${what} must not contain ${JSON.stringify(PARAM_PATH_SEPARATOR)} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** `chan:<channelId>/dev:<instanceId>/<localId>` (SS7). */
export function deviceParamId(
  channelId: ChannelId,
  instanceId: DeviceInstanceId,
  localId: string,
): ParamId {
  return [
    CHANNEL_PREFIX + assertSegment(channelId, "channelId"),
    DEVICE_PREFIX + assertSegment(instanceId, "instanceId"),
    assertSegment(localId, "localId"),
  ].join(PARAM_PATH_SEPARATOR);
}

/** `chan:<channelId>/vol`. */
export function volumeParamId(channelId: ChannelId): ParamId {
  return `${CHANNEL_PREFIX}${assertSegment(channelId, "channelId")}${PARAM_PATH_SEPARATOR}${VOLUME_LEAF}`;
}

/** `chan:<channelId>/pan`. */
export function panParamId(channelId: ChannelId): ParamId {
  return `${CHANNEL_PREFIX}${assertSegment(channelId, "channelId")}${PARAM_PATH_SEPARATOR}${PAN_LEAF}`;
}

/** `chan:<from>/send:<to>` — the amount channel `from` sends to `to`. */
export function sendParamId(from: ChannelId, to: ChannelId): ParamId {
  return `${CHANNEL_PREFIX}${assertSegment(from, "channelId")}${PARAM_PATH_SEPARATOR}${SEND_PREFIX}${assertSegment(to, "targetChannelId")}`;
}

/** Every shape `parseParamId` can recognise. */
export type ParsedParamId =
  | { kind: "device"; channelId: ChannelId; instanceId: DeviceInstanceId; localId: string }
  | { kind: "volume"; channelId: ChannelId }
  | { kind: "pan"; channelId: ChannelId }
  | { kind: "send"; channelId: ChannelId; targetChannelId: ChannelId };

/**
 * Parses a `ParamId` back into its parts, or `null` when the string is not a
 * well-formed param path. Total: never throws.
 */
export function parseParamId(id: ParamId): ParsedParamId | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const parts = id.split(PARAM_PATH_SEPARATOR);
  const head = parts[0];
  if (head === undefined || !head.startsWith(CHANNEL_PREFIX)) return null;
  const channelId = head.slice(CHANNEL_PREFIX.length);
  if (channelId.length === 0) return null;

  if (parts.length === 2) {
    const leaf = parts[1];
    if (leaf === undefined) return null;
    if (leaf === VOLUME_LEAF) return { kind: "volume", channelId };
    if (leaf === PAN_LEAF) return { kind: "pan", channelId };
    if (leaf.startsWith(SEND_PREFIX)) {
      const targetChannelId = leaf.slice(SEND_PREFIX.length);
      if (targetChannelId.length === 0) return null;
      return { kind: "send", channelId, targetChannelId };
    }
    return null;
  }

  if (parts.length === 3) {
    const devSeg = parts[1];
    const localId = parts[2];
    if (devSeg === undefined || localId === undefined) return null;
    if (!devSeg.startsWith(DEVICE_PREFIX)) return null;
    const instanceId = devSeg.slice(DEVICE_PREFIX.length);
    if (instanceId.length === 0 || localId.length === 0) return null;
    return { kind: "device", channelId, instanceId, localId };
  }

  return null;
}

/** True when `id` is any param belonging to `channelId`. */
export function isChannelParamId(id: ParamId, channelId: ChannelId): boolean {
  const parsed = parseParamId(id);
  return parsed !== null && parsed.channelId === channelId;
}

/** True when `id` addresses a param of the given device instance. */
export function isDeviceParamId(id: ParamId, instanceId: DeviceInstanceId): boolean {
  const parsed = parseParamId(id);
  return parsed !== null && parsed.kind === "device" && parsed.instanceId === instanceId;
}

/** The device-local id of a device param path, else `null`. */
export function localParamId(id: ParamId): string | null {
  const parsed = parseParamId(id);
  return parsed !== null && parsed.kind === "device" ? parsed.localId : null;
}

/**
 * SS7: descriptors inside `DeviceDefinition.params` carry the DEVICE-LOCAL id
 * (`"cutoff"`); the harness rewrites it to the full path at registration.
 * Returns a shallow copy — the definition's descriptor object is never mutated
 * (definitions are shared across every instance of the device).
 */
export function qualifyDescriptor(
  desc: ParamDescriptor,
  location: { channelId: ChannelId; instanceId: DeviceInstanceId },
): ParamDescriptor {
  return {
    ...desc,
    id: deviceParamId(location.channelId, location.instanceId, desc.id),
  };
}

/** Rewrites a descriptor's id to an arbitrary full `ParamId` (mixer params). */
export function withParamId(desc: ParamDescriptor, id: ParamId): ParamDescriptor {
  return { ...desc, id };
}
