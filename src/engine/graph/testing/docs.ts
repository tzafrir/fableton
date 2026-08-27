// Hand-built routing documents for the graph tests. Deliberately built with
// explicit ids (not the id factory) so every assertion can name its node
// refs verbatim.

import type { Channel, ChannelId, DeviceInstanceId, Project } from "../../../types";
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
