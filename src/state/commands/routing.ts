// SS6 + SS7 — routing and device-chain commands (SS18-M2).
//
// Every edge edit (output change, send, sidechain) carries a `canRun` that
// re-runs the SS6 DFS cycle check against the WOULD-BE document, so a
// cycle-forming edit is rejected with an inline hint and never reaches the
// store. The check itself lives in src/engine/graph/validate.ts — the same
// function the reconciler's tests use, so the two halves cannot drift.
//
// Device removal keeps automation lanes (SS7: lanes targeting a removed
// device's params are "kept, greyed, and re-bindable — never silently
// deleted"); only `paramValues` entries go, because a value without a
// descriptor is meaningless while a lane without a target is a UI state.

import type {
  ChannelId,
  Command,
  DeviceInstanceId,
  IdFactory,
  ProjectCommands,
  SidechainEdge,
} from "../../types";
import { routingCycleError, sidechainIsFeedForward } from "../../engine/graph/validate";
import { deviceParamId, isChannelParamId, isDeviceParamId, sendParamId } from "../../params";
import {
  defaultMixerParamValues,
  findMasterChannelId,
  makeChannel,
} from "../project";
import { removeRackFromDoc } from "./racks";
import {
  clampInt,
  detachFromChains,
  makeCommand,
  repointSurvivingOutputs,
  type DraftProject,
} from "./util";

export type RoutingCommands = Pick<
  ProjectCommands,
  | "addGroup"
  | "addReturn"
  | "deleteChannels"
  | "setChannelOutput"
  | "setSend"
  | "removeSend"
  | "setSidechain"
  | "removeSidechain"
  | "addEffect"
  | "removeDevices"
  | "moveDevice"
  | "setDeviceEnabled"
  | "setDeviceSetting"
  | "setInstrument"
  | "addAsset"
  | "removeAsset"
>;

/** A fresh send's amount, in dB: silent until the user raises it (SS6). */
export const DEFAULT_SEND_DB = -60;

/** Applies `mutate` to a structurally-shared copy and cycle-checks it. */
function wouldLoop(
  doc: Parameters<NonNullable<Command["canRun"]>>[0],
  mutate: (draft: {
    channels: Record<ChannelId, { id: ChannelId; output: ChannelId | null; sends: { to: ChannelId }[] }>;
    devices: Record<string, { channelId: ChannelId }>;
    sidechains: { from: { channel: ChannelId; tap?: SidechainEdge["from"]["tap"] }; to: { device: string } }[];
  }) => void,
): string | null {
  // A shallow-ish copy is enough: only channels/sends/sidechains are read by
  // the checker, and `mutate` replaces what it changes instead of editing.
  const draft = {
    channels: Object.fromEntries(
      Object.values(doc.channels).map((c) => [
        c.id,
        { id: c.id, output: c.output, sends: c.sends.map((s) => ({ to: s.to })) },
      ]),
    ),
    devices: Object.fromEntries(
      Object.values(doc.devices).map((d) => [d.id, { channelId: d.channelId }]),
    ),
    sidechains: doc.sidechains.map((e) => ({
      from: { channel: e.from.channel, tap: e.from.tap },
      to: { device: e.to.device },
    })),
  };
  mutate(draft);
  return routingCycleError({
    channels: draft.channels,
    devices: draft.devices as never,
    sidechains: draft.sidechains,
  });
}

/** Row of the master channel, or the end when there is none (new rows go
 *  above the master so it stays the bottom strip). */
function masterRow(doc: DraftProject): number {
  const masterId = findMasterChannelId(doc);
  if (masterId === undefined) return doc.channelOrder.length;
  const row = doc.channelOrder.indexOf(masterId);
  return row < 0 ? doc.channelOrder.length : row;
}

function removeParamValuesOf(doc: DraftProject, keep: (id: string) => boolean): void {
  for (const id of Object.keys(doc.paramValues)) {
    if (!keep(id)) delete doc.paramValues[id];
  }
}

/** Deletes one device from wherever it hangs; lanes are deliberately kept. */
/** A chain slot holds a device OR a rack; callers that iterate slots do not
 *  know which, so this dispatches on the collection the id resolves in. */
function removeChainEntry(doc: DraftProject, entryId: DeviceInstanceId): void {
  if (doc.racks[entryId] !== undefined) removeRackFromDoc(doc, entryId);
  else removeDeviceFromDoc(doc, entryId);
}

function removeDeviceFromDoc(doc: DraftProject, deviceId: DeviceInstanceId): void {
  const device = doc.devices[deviceId];
  if (device === undefined) return;
  // Covers the channel chain, the source slot AND any rack chain the device
  // sits in — a device removed from inside a rack must leave no dead id.
  detachFromChains(doc, deviceId);
  doc.sidechains = doc.sidechains.filter((e) => e.to.device !== deviceId);
  removeParamValuesOf(doc, (id) => !isDeviceParamId(id, deviceId));
  delete doc.devices[deviceId];
}

function countByRole(doc: DraftProject, role: "group" | "return"): number {
  let n = 0;
  for (const c of Object.values(doc.channels)) if (c.role === role) n += 1;
  return n;
}

export function createRoutingCommands(ids: IdFactory): RoutingCommands {
  return {
    addGroup(memberIds = [], init = {}): Command {
      const groupId = init.id ?? ids.channel();
      const members = [...memberIds];
      return makeCommand(
        "Group Channels",
        (doc) => {
          const master = findMasterChannelId(doc) ?? null;
          const present = members.filter(
            (id) => doc.channels[id] !== undefined && doc.channels[id]?.role !== "master",
          );
          // The group adopts the members' common parent, falling back to the
          // master — so grouping inside a group nests naturally (SS6).
          const parents = new Set(present.map((id) => doc.channels[id]?.output ?? master));
          const output = parents.size === 1 ? [...parents][0] ?? master : master;
          const group = makeChannel({
            id: groupId,
            role: "group",
            name: init.name ?? `Group ${countByRole(doc, "group") + 1}`,
            color: init.color ?? null,
            output,
          });
          doc.channels[groupId] = group;
          // The group's row: where its first member was (visually replacing
          // the run of members), else just above the master.
          const firstRow = present
            .map((id) => doc.channelOrder.indexOf(id))
            .filter((row) => row >= 0)
            .sort((a, b) => a - b)[0];
          doc.channelOrder.splice(firstRow ?? masterRow(doc), 0, groupId);
          Object.assign(doc.paramValues, defaultMixerParamValues(groupId));
          for (const id of present) {
            const member = doc.channels[id];
            if (member !== undefined) member.output = groupId;
          }
        },
        {
          canRun: (doc) => {
            for (const id of members) {
              if (doc.channels[id]?.role === "master") return "the master cannot be grouped";
            }
            return null;
          },
        },
      );
    },

    addReturn(init = {}): Command {
      const returnId = init.id ?? ids.channel();
      return makeCommand("Add Return", (doc) => {
        const returnChannel = makeChannel({
          id: returnId,
          role: "return",
          name: init.name ?? `Return ${String.fromCharCode(65 + countByRole(doc, "return"))}`,
          color: init.color ?? null,
          output: findMasterChannelId(doc) ?? null,
        });
        doc.channels[returnId] = returnChannel;
        doc.channelOrder.splice(masterRow(doc), 0, returnId);
        Object.assign(doc.paramValues, defaultMixerParamValues(returnId));
      });
    },

    deleteChannels(channelIds): Command {
      const targets = [...channelIds];
      return makeCommand(
        targets.length === 1 ? "Delete Channel" : "Delete Channels",
        (doc) => {
          const dying = new Set(targets.filter((id) => doc.channels[id]?.role !== "master"));
          if (dying.size === 0) return;
          // Members re-point to the dying group's own output (SS6: moving a
          // track is a one-field edit; deleting a group must not orphan).
          // Shared with `deleteTracks`: the walk climbs the whole dying branch,
          // so deleting a group AND its parent in one dispatch cannot leave a
          // survivor naming a deleted channel, whatever order they came in.
          repointSurvivingOutputs(doc, dying);
          for (const other of Object.values(doc.channels)) {
            if (dying.has(other.id)) continue;
            if (other.sends.some((s) => dying.has(s.to))) {
              for (const send of other.sends) {
                if (dying.has(send.to)) delete doc.paramValues[send.amount];
              }
              other.sends = other.sends.filter((s) => !dying.has(s.to));
            }
          }
          doc.sidechains = doc.sidechains.filter((e) => {
            if (dying.has(e.from.channel)) return false;
            const device = doc.devices[e.to.device];
            return device === undefined || !dying.has(device.channelId);
          });
          for (const id of dying) {
            const channel = doc.channels[id];
            if (channel === undefined) continue;
            for (const entryId of [...channel.chain]) removeChainEntry(doc, entryId);
            if (channel.source !== null) removeDeviceFromDoc(doc, channel.source.deviceId);
          }
          for (const clip of Object.values(doc.clips)) {
            if (dying.has(clip.trackId)) delete doc.clips[clip.id];
          }
          // Lanes hang off the channel that owns the target param (SS11), so a
          // deleted channel takes its lanes with it. Unlike the SS7 "kept,
          // greyed, re-bindable" rule for a removed DEVICE's lanes, there is
          // no channel left to hang these on: keeping them would leave the
          // document illegal (invariant: `lane.channelId` names a channel) and
          // the codec would silently drop them on the next load.
          for (const [laneId, lane] of Object.entries(doc.lanes)) {
            if (dying.has(lane.channelId)) delete doc.lanes[laneId];
          }
          for (const id of dying) {
            removeParamValuesOf(doc, (paramId) => !isChannelParamId(paramId, id));
            delete doc.channels[id];
          }
          doc.channelOrder = doc.channelOrder.filter((id) => !dying.has(id));
        },
      );
    },

    setChannelOutput(channelId, output): Command {
      return makeCommand(
        "Set Audio To",
        (doc) => {
          const channel = doc.channels[channelId];
          if (channel === undefined || channel.role === "master") return;
          if (doc.channels[output] === undefined) return;
          channel.output = output;
        },
        {
          canRun: (doc) => {
            if (doc.channels[channelId] === undefined) return "unknown channel";
            if (doc.channels[channelId]?.role === "master") return "the master's output is fixed";
            if (doc.channels[output] === undefined) return "unknown output target";
            return wouldLoop(doc, (draft) => {
              const channel = draft.channels[channelId];
              if (channel !== undefined) channel.output = output;
            });
          },
        },
      );
    },

    setSend(from, to, tap = "post"): Command {
      const amount = sendParamId(from, to);
      return makeCommand(
        "Set Send",
        (doc) => {
          const channel = doc.channels[from];
          if (channel === undefined || doc.channels[to] === undefined) return;
          const existing = channel.sends.find((s) => s.to === to);
          if (existing !== undefined) {
            existing.tap = tap;
            return;
          }
          channel.sends.push({ to, amount, tap });
          if (doc.paramValues[amount] === undefined) doc.paramValues[amount] = DEFAULT_SEND_DB;
        },
        {
          canRun: (doc) => {
            if (doc.channels[from] === undefined || doc.channels[to] === undefined) {
              return "unknown channel";
            }
            if (from === to) return "a channel cannot send to itself";
            return wouldLoop(doc, (draft) => {
              const channel = draft.channels[from];
              if (channel !== undefined && !channel.sends.some((s) => s.to === to)) {
                channel.sends.push({ to });
              }
            });
          },
        },
      );
    },

    removeSend(from, to): Command {
      return makeCommand("Remove Send", (doc) => {
        const channel = doc.channels[from];
        if (channel === undefined) return;
        const send = channel.sends.find((s) => s.to === to);
        if (send === undefined) return;
        delete doc.paramValues[send.amount];
        channel.sends = channel.sends.filter((s) => s.to !== to);
      });
    },

    setSidechain(edge): Command {
      const copy: SidechainEdge = {
        from: { channel: edge.from.channel, tap: edge.from.tap },
        to: { device: edge.to.device, port: edge.to.port },
      };
      return makeCommand(
        "Set Audio From",
        (doc) => {
          if (doc.channels[copy.from.channel] === undefined) return;
          if (doc.devices[copy.to.device] === undefined) return;
          // One edge per (device, port): setting replaces.
          doc.sidechains = doc.sidechains.filter(
            (e) => !(e.to.device === copy.to.device && e.to.port === copy.to.port),
          );
          doc.sidechains.push(copy);
        },
        {
          canRun: (doc) => {
            if (doc.channels[copy.from.channel] === undefined) return "unknown source channel";
            const device = doc.devices[copy.to.device];
            if (device === undefined) return "unknown device";
            // Same-channel keying is a cycle only from a tap DOWNSTREAM of
            // the device; `preFx` resolves to the channel input, upstream of
            // every device in its chain, so keying from it is feed-forward.
            // That is precisely how a gate keys off its own channel's dry
            // signal (gated reverb). See `sidechainIsFeedForward`.
            if (
              device.channelId === copy.from.channel &&
              !sidechainIsFeedForward(copy.from.channel, device.channelId, copy.from.tap)
            ) {
              return `a device cannot sidechain its own channel from the ${copy.from.tap} tap (it would loop); use preFx`;
            }
            return wouldLoop(doc, (draft) => {
              draft.sidechains = draft.sidechains.filter((e) => e.to.device !== copy.to.device);
              draft.sidechains.push({
                from: { channel: copy.from.channel, tap: copy.from.tap },
                to: { device: copy.to.device },
              });
            });
          },
        },
      );
    },

    removeSidechain(deviceId, port): Command {
      return makeCommand("Clear Audio From", (doc) => {
        doc.sidechains = doc.sidechains.filter(
          (e) => e.to.device !== deviceId || (port !== undefined && e.to.port !== port),
        );
      });
    },

    addEffect(channelId, init, index): Command {
      const deviceId = init.deviceId ?? ids.device();
      return makeCommand("Add Effect", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        doc.devices[deviceId] = {
          id: deviceId,
          definitionId: init.definitionId,
          version: init.version ?? 1,
          channelId,
          enabled: true,
        };
        const at = index === undefined ? channel.chain.length : clampInt(index, 0, channel.chain.length);
        channel.chain.splice(at, 0, deviceId);
      });
    },

    removeDevices(deviceIds): Command {
      const targets = [...deviceIds];
      return makeCommand(targets.length === 1 ? "Remove Device" : "Remove Devices", (doc) => {
        for (const id of targets) removeChainEntry(doc, id);
      });
    },

    moveDevice(channelId, deviceId, toIndex): Command {
      return makeCommand("Move Device", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        const from = channel.chain.indexOf(deviceId);
        if (from < 0) return;
        const to = clampInt(toIndex, 0, channel.chain.length - 1);
        if (from === to) return;
        channel.chain.splice(from, 1);
        channel.chain.splice(to, 0, deviceId);
      });
    },

    setDeviceEnabled(deviceId, enabled): Command {
      return makeCommand(enabled ? "Enable Device" : "Disable Device", (doc) => {
        const device = doc.devices[deviceId];
        if (device !== undefined) device.enabled = enabled;
      });
    },

    setDeviceSetting(deviceId, key, value): Command {
      return makeCommand(value === null ? "Clear Setting" : "Set Setting", (doc) => {
        const device = doc.devices[deviceId];
        if (device === undefined) return;
        if (value === null) {
          if (device.settings === undefined) return;
          delete device.settings[key];
          // Document invariant 9: no key holds `undefined`, and an empty map
          // is noise in every diff and every saved file.
          if (Object.keys(device.settings).length === 0) delete device.settings;
          return;
        }
        if (device.settings === undefined) device.settings = {};
        device.settings[key] = value;
      });
    },

    addAsset(asset): Command {
      // Copied field by field rather than spread: the caller owns its object,
      // and the document must not end up holding a reference to something
      // that can be mutated behind its back (SS13: plain, owned data).
      const stored = {
        id: asset.id,
        name: asset.name,
        sampleRate: Math.max(1, Math.round(asset.sampleRate)),
        channels: Math.max(1, Math.round(asset.channels)),
        frames: Math.max(0, Math.round(asset.frames)),
      };
      return makeCommand("Import Sample", (doc) => {
        doc.assets[stored.id] = { ...stored };
      });
    },

    removeAsset(assetId): Command {
      return makeCommand("Remove Sample", (doc) => {
        delete doc.assets[assetId];
      });
    },

    setInstrument(channelId, init, carryValues): Command {
      const deviceId = init.deviceId ?? ids.device();
      const carry = carryValues === undefined ? undefined : { ...carryValues };
      return makeCommand("Set Instrument", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined || channel.role !== "track") return;
        // SS7 swap: the OLD instance goes (its values with it); lanes naming
        // its params survive as data (see file header).
        if (channel.source !== null) removeDeviceFromDoc(doc, channel.source.deviceId);
        doc.devices[deviceId] = {
          id: deviceId,
          definitionId: init.definitionId,
          version: init.version ?? 1,
          channelId,
          enabled: true,
        };
        channel.source = { kind: "instrument", deviceId };
        if (carry !== undefined) {
          for (const [localId, value] of Object.entries(carry)) {
            doc.paramValues[deviceParamId(channelId, deviceId, localId)] = value;
          }
        }
      });
    },
  };
}
