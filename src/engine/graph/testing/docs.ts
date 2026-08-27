// Hand-built routing documents for the graph tests. Deliberately built with
// explicit ids (not the id factory) so every assertion can name its node
// refs verbatim.

import type {
  Channel,
  ChannelId,
  DeviceInstanceId,
  Project,
  RackChainId,
  RackId,
  RackState,
} from "../../../types";
import { rackChainParamId } from "../../../params/paramIds";
import {
  defaultMixerParamValues,
  DEFAULT_BPM,
  DEFAULT_TIME_SIGNATURE,
  makeChannel,
} from "../../../state/project";

export interface DocSpec {
  channels: Partial<Channel>[];
  devices?: { id: DeviceInstanceId; definitionId: string; channelId: ChannelId; enabled?: boolean }[];
  sidechains?: Project["sidechains"];
  racks?: RackSpec[];
}

/** A rack, as a test spells it: chains as plain device-id lists. */
export interface RackSpec {
  id: RackId;
  channelId: ChannelId;
  enabled?: boolean;
  chains: { id: RackChainId; devices?: DeviceInstanceId[]; mute?: boolean; solo?: boolean }[];
}

/** A `Project` with just the routing parts filled in. */
export function routingDoc(spec: DocSpec): Project {
  const channels: Record<ChannelId, Channel> = {};
  const channelOrder: ChannelId[] = [];
  let paramValues: Record<string, number> = {};
  for (const part of spec.channels) {
    const id = part.id ?? `chan-${channelOrder.length + 1}`;
    const base = makeChannel({
      id,
      role: part.role ?? "track",
      name: part.name ?? id,
      output: part.output !== undefined ? part.output : "master",
    });
    const channel: Channel = { ...base, ...part, id };
    channels[id] = channel;
    channelOrder.push(id);
    paramValues = { ...paramValues, ...defaultMixerParamValues(id) };
  }

  const devices: Project["devices"] = {};
  for (const d of spec.devices ?? []) {
    devices[d.id] = {
      id: d.id,
      definitionId: d.definitionId,
      version: 1,
      channelId: d.channelId,
      enabled: d.enabled ?? true,
    };
  }

  const racks: Record<RackId, RackState> = {};
  for (const r of spec.racks ?? []) {
    racks[r.id] = {
      id: r.id,
      channelId: r.channelId,
      name: r.id,
      enabled: r.enabled ?? true,
      chains: r.chains.map((c) => ({
        id: c.id,
        name: c.id,
        devices: c.devices ?? [],
        mute: c.mute ?? false,
        solo: c.solo ?? false,
        gain: rackChainParamId(r.channelId, r.id, c.id, "gain"),
        pan: rackChainParamId(r.channelId, r.id, c.id, "pan"),
      })),
      macros: [],
    };
  }

  return {
    id: "test-project",
    name: "Test",
    tempo: [{ startTick: 0, bpm: DEFAULT_BPM }],
    timeSignature: DEFAULT_TIME_SIGNATURE,
    loop: { enabled: false, start: 0, end: 3840 },
    channelOrder,
    channels,
    devices,
    clips: {},
    lanes: {},
    racks,
    sidechains: spec.sidechains ?? [],
    paramValues,
  };
}

/** master + two tracks, no devices — the smallest interesting doc. */
export function twoTrackDoc(): Project {
  return routingDoc({
    channels: [
      { id: "t1", role: "track" },
      { id: "t2", role: "track" },
      { id: "master", role: "master", output: null },
    ],
  });
}
