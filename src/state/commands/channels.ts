// SS6 — channels. Tracks, groups, returns and the master are the same type
// with a `role` tag; M1 only creates `'track'` ones, but every verb here is
// written against `Channel`, so M2's groups and returns cost nothing new.
//
// `channelOrder` is the arrangement's row order (document invariant 2) and is
// kept a permutation of `Object.keys(channels)` by every command below.

import type {
  ChannelId,
  Command,
  DeviceInstanceId,
  IdFactory,
  ProjectCommands,
  ProjectSnapshot,
  TrackInit,
} from "../../types";
import { parseParamId } from "../../params";
import {
  DEFAULT_INSTRUMENT_VERSION,
  defaultMixerParamValues,
  findMasterChannelId,
  makeChannel,
  makeInstrumentDevice,
} from "../project";
import { trackColorAt } from "../../ui/theme";
import { clampInt, makeCommand, repointSurvivingOutputs, type DraftProject } from "./util";

export type ChannelCommands = Pick<
  ProjectCommands,
  | "addTrack"
  | "deleteTracks"
  | "renameChannel"
  | "setChannelColor"
  | "moveChannel"
  | "setChannelMuted"
  | "setChannelSolo"
>;

/** Row of the master channel, or `channelOrder.length` when there is none.
 *  New tracks are inserted above it so the master stays the bottom row. */
function masterRow(doc: DraftProject): number {
  const masterId = findMasterChannelId(doc);
  if (masterId === undefined) return doc.channelOrder.length;
  const row = doc.channelOrder.indexOf(masterId);
  return row < 0 ? doc.channelOrder.length : row;
}

function nextTrackName(doc: DraftProject): string {
  let tracks = 0;
  for (const channel of Object.values(doc.channels)) {
    if (channel.role === "track") tracks += 1;
  }
  return `Track ${tracks + 1}`;
}

/** How many tracks the document already has — the index the next track's
 *  default colour is taken from. */
function countTracks(doc: DraftProject): number {
  let n = 0;
  for (const id of doc.channelOrder) {
    if (doc.channels[id]?.role === "track") n += 1;
  }
  return n;
}

/** Every device instance a channel owns: its source slot plus its chain. */
function devicesOfChannel(doc: DraftProject, channelId: ChannelId): DeviceInstanceId[] {
  const channel = doc.channels[channelId];
  if (channel === undefined) return [];
  const out = [...channel.chain];
  if (channel.source !== null) out.push(channel.source.deviceId);
  return out;
}

export function createChannelCommands(ids: IdFactory): ChannelCommands {
  return {
    addTrack(init: TrackInit | undefined = undefined): Command {
      const channelId = init?.id ?? ids.channel();
      const instrument = init?.instrument ?? null;
      // Minted eagerly (see types/commands `Command`): redo replays patches.
      const deviceId = instrument === null ? null : (instrument.deviceId ?? ids.device());
      const index = init?.index;
      const name = init?.name;
      const color = init?.color;
      return makeCommand(
        "Add Track",
        (doc) => {
          const output = findMasterChannelId(doc) ?? null;
          const channel = makeChannel({
            id: channelId,
            role: "track",
            name: name ?? nextTrackName(doc),
            // A track with no colour of its own takes the next hue off the
            // design system's ribbon (`TRACK_COLORS`). The arrangement and
            // the mixer both key their clip/strip colour off this field, so
            // giving it a value here is what stops an eight-part song
            // rendering as one blue wall. Deterministic in the document, so
            // undo/redo and reload all agree.
            color: color ?? trackColorAt(countTracks(doc)),
            output,
          });
          if (instrument !== null && deviceId !== null) {
            channel.source = { kind: "instrument", deviceId };
            doc.devices[deviceId] = makeInstrumentDevice(
              deviceId,
              channelId,
              instrument.definitionId,
              instrument.version ?? DEFAULT_INSTRUMENT_VERSION,
            );
          }
          doc.channels[channelId] = channel;
          const at = index === undefined ? masterRow(doc) : clampInt(index, 0, masterRow(doc));
          doc.channelOrder.splice(at, 0, channelId);
          for (const [paramId, value] of Object.entries(defaultMixerParamValues(channelId))) {
            doc.paramValues[paramId] = value;
          }
        },
        {
          canRun: (doc: ProjectSnapshot): string | null =>
            doc.channels[channelId] === undefined ? null : "A channel with that id already exists.",
        },
      );
    },

    deleteTracks(channelIds: readonly ChannelId[]): Command {
      const doomed = [...new Set(channelIds)];
      return makeCommand(
        doomed.length === 1 ? "Delete Track" : "Delete Tracks",
        (doc) => {
          const removed = new Set<ChannelId>();
          const removedDevices = new Set<DeviceInstanceId>();
          for (const channelId of doomed) {
            const channel = doc.channels[channelId];
            if (channel === undefined || channel.role === "master") continue;
            removed.add(channelId);
            for (const deviceId of devicesOfChannel(doc, channelId)) removedDevices.add(deviceId);
          }
          if (removed.size === 0) return;

          // Anything that fed a removed channel now feeds what IT fed —
          // walked before the deletion (see `repointSurvivingOutputs`).
          repointSurvivingOutputs(doc, removed);
          for (const channelId of removed) {
            delete doc.channels[channelId];
            const row = doc.channelOrder.indexOf(channelId);
            if (row >= 0) doc.channelOrder.splice(row, 1);
          }

          for (const deviceId of removedDevices) delete doc.devices[deviceId];

          for (const [clipId, clip] of Object.entries(doc.clips)) {
            if (removed.has(clip.trackId)) delete doc.clips[clipId];
          }
          for (const [laneId, lane] of Object.entries(doc.lanes)) {
            if (removed.has(lane.channelId)) delete doc.lanes[laneId];
          }

          // Sends INTO a removed channel go, and so does the send amount param
          // they own (its id names the destination).
          for (const channel of Object.values(doc.channels)) {
            for (let i = channel.sends.length - 1; i >= 0; i--) {
              const send = channel.sends[i];
              if (send === undefined || !removed.has(send.to)) continue;
              delete doc.paramValues[send.amount];
              channel.sends.splice(i, 1);
            }
          }

          for (let i = doc.sidechains.length - 1; i >= 0; i--) {
            const edge = doc.sidechains[i];
            if (edge === undefined) continue;
            if (removed.has(edge.from.channel) || removedDevices.has(edge.to.device)) {
              doc.sidechains.splice(i, 1);
            }
          }

          // Every param a removed channel owned — its mixer params AND its
          // devices' params, which are all `chan:<id>/...` (SS4 id scheme).
          for (const paramId of Object.keys(doc.paramValues)) {
            const parsed = parseParamId(paramId);
            if (parsed === null) continue;
            if (removed.has(parsed.channelId) || (parsed.kind === "send" && removed.has(parsed.targetChannelId))) {
              delete doc.paramValues[paramId];
              continue;
            }
            if (parsed.kind === "device" && removedDevices.has(parsed.instanceId)) {
              delete doc.paramValues[paramId];
            }
          }
        },
        {
          canRun: (doc: ProjectSnapshot): string | null => {
            for (const channelId of doomed) {
              if (doc.channels[channelId]?.role === "master") return "The master channel cannot be deleted.";
            }
            return null;
          },
        },
      );
    },

    renameChannel(channelId: ChannelId, name: string): Command {
      return makeCommand(
        "Rename Track",
        (doc) => {
          const channel = doc.channels[channelId];
          if (channel === undefined) return;
          channel.name = name;
        },
        { coalesceKey: `channel.name:${channelId}` },
      );
    },

    setChannelColor(channelId: ChannelId, color: string | null): Command {
      return makeCommand("Set Track Color", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        channel.color = color;
      });
    },

    moveChannel(channelId: ChannelId, toIndex: number): Command {
      return makeCommand("Reorder Tracks", (doc) => {
        const from = doc.channelOrder.indexOf(channelId);
        if (from < 0) return;
        const isMaster = doc.channels[channelId]?.role === "master";
        doc.channelOrder.splice(from, 1);
        // The master keeps the bottom row: nothing is ordered below it.
        const limit = isMaster ? doc.channelOrder.length : masterRow(doc);
        const to = clampInt(toIndex, 0, limit);
        doc.channelOrder.splice(to, 0, channelId);
      });
    },

    setChannelMuted(channelId: ChannelId, muted: boolean): Command {
      return makeCommand(muted ? "Mute Track" : "Unmute Track", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        channel.mute = muted;
      });
    },

    setChannelSolo(channelId: ChannelId, solo: boolean): Command {
      return makeCommand(solo ? "Solo Track" : "Unsolo Track", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        channel.solo = solo;
      });
    },
  };
}
