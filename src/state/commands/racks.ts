// SS7 racks — the edit vocabulary for parallel device chains.
//
// A rack occupies ONE slot of a channel's chain and holds N parallel chains
// between a split and a sum (see src/engine/graph/build.ts). Its id lives in
// the same namespace as a device instance's, so every command that already
// speaks chain slots — reorder, and the panel that renders them — keeps
// working, and a rack's params are ordinary `chan:<c>/dev:<rack>/...` paths
// that automate, undo and save with no new machinery.
//
// The devices inside a rack are UNCHANGED instances in `doc.devices`:
// grouping into a rack moves ids between lists, never rebuilds a device, so
// param values and automation lanes survive grouping and ungrouping intact.

import type {
  ChannelId,
  Command,
  DeviceInstanceId,
  IdFactory,
  ProjectCommands,
  RackChain,
  RackChainId,
  RackId,
} from "../../types";
import { deviceParamId, isDeviceParamId, rackChainParamId } from "../../params";
import { clampInt, detachFromChains, makeCommand, type DraftProject } from "./util";

export type RackCommands = Pick<
  ProjectCommands,
  | "addRack"
  | "groupIntoRack"
  | "ungroupRack"
  | "addRackChain"
  | "addEffectToChain"
  | "addRackPreset"
  | "removeRackChain"
  | "moveDeviceToChain"
  | "setChainMuted"
  | "setChainSolo"
  | "setRackEnabled"
  | "renameRack"
  | "renameRackChain"
>;

/** A new chain sits at unity gain, centred — the neutral parallel branch. */
export const DEFAULT_CHAIN_GAIN_DB = 0;
export const DEFAULT_CHAIN_PAN = 0;

function makeChain(
  channelId: ChannelId,
  rackId: RackId,
  chainId: RackChainId,
  name: string,
  devices: DeviceInstanceId[] = [],
): RackChain {
  return {
    id: chainId,
    name,
    devices,
    mute: false,
    solo: false,
    gain: rackChainParamId(channelId, rackId, chainId, "gain"),
    pan: rackChainParamId(channelId, rackId, chainId, "pan"),
  };
}

function seedChainParams(doc: DraftProject, chain: RackChain): void {
  doc.paramValues[chain.gain] = DEFAULT_CHAIN_GAIN_DB;
  doc.paramValues[chain.pan] = DEFAULT_CHAIN_PAN;
}

function dropChainParams(doc: DraftProject, chain: { gain: string; pan: string }): void {
  delete doc.paramValues[chain.gain];
  delete doc.paramValues[chain.pan];
}

export function createRackCommands(ids: IdFactory): RackCommands {
  /** Mints a rack + its first chain up front — ids are never generated
   *  inside `run` (redo replays patches, not the command). */
  const mintRack = (): { rackId: RackId; chainId: RackChainId } => ({
    rackId: ids.rack(),
    chainId: ids.chain(),
  });

  return {
    addRack(channelId, index): Command {
      const { rackId, chainId } = mintRack();
      return makeCommand("Add Rack", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        const chain = makeChain(channelId, rackId, chainId, "Chain 1");
        doc.racks[rackId] = {
          id: rackId,
          channelId,
          name: "Rack",
          enabled: true,
          chains: [chain],
          macros: [],
        };
        seedChainParams(doc, chain);
        const at = index === undefined ? channel.chain.length : clampInt(index, 0, channel.chain.length);
        channel.chain.splice(at, 0, rackId);
      });
    },

    groupIntoRack(channelId, deviceIds): Command {
      const { rackId, chainId } = mintRack();
      const targets = [...deviceIds];
      return makeCommand("Group Into Rack", (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        // Only devices actually sitting in THIS channel's chain, in chain
        // order — grouping must not reorder what it wraps.
        const members = channel.chain.filter(
          (id) => targets.includes(id) && doc.devices[id] !== undefined,
        );
        if (members.length === 0) return;
        const at = channel.chain.indexOf(members[0] as string);
        const chain = makeChain(channelId, rackId, chainId, "Chain 1", members);
        doc.racks[rackId] = {
          id: rackId,
          channelId,
          name: "Rack",
          enabled: true,
          chains: [chain],
          macros: [],
        };
        seedChainParams(doc, chain);
        channel.chain = channel.chain.filter((id) => !members.includes(id));
        channel.chain.splice(Math.min(at, channel.chain.length), 0, rackId);
      });
    },

    ungroupRack(rackId): Command {
      return makeCommand("Ungroup Rack", (doc) => {
        const rack = doc.racks[rackId];
        if (rack === undefined) return;
        const channel = doc.channels[rack.channelId];
        // Chains are concatenated in order: a parallel arrangement cannot be
        // preserved in a serial chain, and stacking them is the only reading
        // that keeps every device.
        const devices = rack.chains.flatMap((c) => c.devices);
        for (const chain of rack.chains) dropChainParams(doc, chain);
        for (const macro of rack.macros) delete doc.paramValues[macro.param];
        delete doc.racks[rackId];
        if (channel === undefined) return;
        const at = channel.chain.indexOf(rackId);
        if (at < 0) {
          channel.chain.push(...devices);
          return;
        }
        channel.chain.splice(at, 1, ...devices);
      });
    },

    addRackChain(rackId, name): Command {
      const chainId = ids.chain();
      return makeCommand("Add Chain", (doc) => {
        const rack = doc.racks[rackId];
        if (rack === undefined) return;
        const chain = makeChain(
          rack.channelId,
          rackId,
          chainId,
          name ?? `Chain ${rack.chains.length + 1}`,
        );
        rack.chains.push(chain);
        seedChainParams(doc, chain);
      });
    },

    addRackPreset(channelId, spec, index): Command {
      // Every id is minted HERE, before `run` — redo replays patches, so an
      // id generated inside `run` would differ between the first dispatch and
      // any later replay.
      const rackId = ids.rack();
      const chains = spec.chains.map((chain) => ({
        id: ids.chain(),
        name: chain.name,
        devices: chain.devices.map((device) => ({ id: ids.device(), spec: device })),
      }));
      return makeCommand(`Add ${spec.name}`, (doc) => {
        const channel = doc.channels[channelId];
        if (channel === undefined) return;
        const rackChains: RackChain[] = [];
        for (const [i, chain] of chains.entries()) {
          const built = makeChain(
            channelId,
            rackId,
            chain.id,
            chain.name ?? `Chain ${String(i + 1)}`,
            chain.devices.map((d) => d.id),
          );
          rackChains.push(built);
          seedChainParams(doc, built);
          for (const device of chain.devices) {
            doc.devices[device.id] = {
              id: device.id,
              definitionId: device.spec.definitionId,
              version: device.spec.version ?? 1,
              channelId,
              enabled: true,
            };
            for (const [localId, value] of Object.entries(device.spec.params ?? {})) {
              doc.paramValues[deviceParamId(channelId, device.id, localId)] = value;
            }
            const tap = device.spec.sidechainFromHost;
            if (tap !== undefined) {
              doc.sidechains.push({
                from: { channel: channelId, tap },
                to: { device: device.id, port: "sc" },
              });
            }
          }
        }
        doc.racks[rackId] = {
          id: rackId,
          channelId,
          name: spec.name,
          enabled: true,
          chains: rackChains,
          macros: [],
        };
        const at = index === undefined ? channel.chain.length : clampInt(index, 0, channel.chain.length);
        channel.chain.splice(at, 0, rackId);
      });
    },

    addEffectToChain(rackId, chainId, init, index): Command {
      const deviceId = init.deviceId ?? ids.device();
      return makeCommand("Add Effect", (doc) => {
        const rack = doc.racks[rackId];
        const chain = rack?.chains.find((c) => c.id === chainId);
        if (rack === undefined || chain === undefined) return;
        // The device is hosted by the rack's CHANNEL — a rack changes wiring,
        // not ownership, so the param path is the ordinary one.
        doc.devices[deviceId] = {
          id: deviceId,
          definitionId: init.definitionId,
          version: init.version ?? 1,
          channelId: rack.channelId,
          enabled: true,
        };
        const at = index === undefined ? chain.devices.length : clampInt(index, 0, chain.devices.length);
        chain.devices.splice(at, 0, deviceId);
      });
    },

    removeRackChain(rackId, chainId): Command {
      return makeCommand("Remove Chain", (doc) => {
        const rack = doc.racks[rackId];
        if (rack === undefined) return;
        const chain = rack.chains.find((c) => c.id === chainId);
        if (chain === undefined) return;
        // The chain's devices have no other home — a device belongs to
        // exactly one list — so they go with it, values and all.
        for (const deviceId of [...chain.devices]) removeDeviceInRack(doc, deviceId);
        dropChainParams(doc, chain);
        rack.chains = rack.chains.filter((c) => c.id !== chainId);
      });
    },

    moveDeviceToChain(rackId, deviceId, chainId, index): Command {
      return makeCommand("Move Device", (doc) => {
        const rack = doc.racks[rackId];
        const device = doc.devices[deviceId];
        if (rack === undefined || device === undefined) return;
        // A rack only ever holds devices of its own channel: moving across
        // channels would invalidate every param id the device owns.
        if (device.channelId !== rack.channelId) return;
        const target = rack.chains.find((c) => c.id === chainId);
        if (target === undefined) return;
        detachFromChains(doc, deviceId);
        // Re-read: `detachFromChains` replaces the `devices` array of every
        // chain it strips the id from, so a reference taken before it would
        // be stale.
        const list = rack.chains.find((c) => c.id === chainId);
        if (list === undefined) return;
        const at = index === undefined ? list.devices.length : clampInt(index, 0, list.devices.length);
        list.devices.splice(at, 0, deviceId);
      });
    },

    setChainMuted(rackId, chainId, muted): Command {
      return makeCommand(muted ? "Mute Chain" : "Unmute Chain", (doc) => {
        const chain = doc.racks[rackId]?.chains.find((c) => c.id === chainId);
        if (chain !== undefined) chain.mute = muted;
      });
    },

    setChainSolo(rackId, chainId, solo): Command {
      return makeCommand(solo ? "Solo Chain" : "Unsolo Chain", (doc) => {
        const chain = doc.racks[rackId]?.chains.find((c) => c.id === chainId);
        if (chain !== undefined) chain.solo = solo;
      });
    },

    setRackEnabled(rackId, enabled): Command {
      return makeCommand(enabled ? "Enable Rack" : "Disable Rack", (doc) => {
        const rack = doc.racks[rackId];
        if (rack !== undefined) rack.enabled = enabled;
      });
    },

    renameRack(rackId, name): Command {
      return makeCommand(
        "Rename Rack",
        (doc) => {
          const rack = doc.racks[rackId];
          if (rack !== undefined) rack.name = name;
        },
        { coalesceKey: `rack.name.${rackId}` },
      );
    },

    renameRackChain(rackId, chainId, name): Command {
      return makeCommand(
        "Rename Chain",
        (doc) => {
          const chain = doc.racks[rackId]?.chains.find((c) => c.id === chainId);
          if (chain !== undefined) chain.name = name;
        },
        { coalesceKey: `rack.chain.name.${rackId}.${chainId}` },
      );
    },
  };
}

/**
 * Removes a rack and everything only it holds: its chains' devices, its
 * chain and macro param values, and its slot in the hosting channel's chain.
 * Used by `removeDevices` and by channel deletion, both of which iterate
 * chain slots without knowing which kind each one is.
 */
export function removeRackFromDoc(doc: DraftProject, rackId: RackId): void {
  const rack = doc.racks[rackId];
  if (rack === undefined) return;
  for (const chain of rack.chains) {
    for (const deviceId of [...chain.devices]) removeDeviceInRack(doc, deviceId);
    dropChainParams(doc, chain);
  }
  for (const macro of rack.macros) delete doc.paramValues[macro.param];
  const channel = doc.channels[rack.channelId];
  if (channel !== undefined) channel.chain = channel.chain.filter((id) => id !== rackId);
  delete doc.racks[rackId];
}

/** Device removal from inside a rack — the same cleanup `removeDevices`
 *  performs on a channel chain. */
function removeDeviceInRack(doc: DraftProject, deviceId: DeviceInstanceId): void {
  if (doc.devices[deviceId] === undefined) return;
  detachFromChains(doc, deviceId);
  doc.sidechains = doc.sidechains.filter((e) => e.to.device !== deviceId);
  for (const key of Object.keys(doc.paramValues)) {
    if (isDeviceParamId(key, deviceId)) delete doc.paramValues[key];
  }
  delete doc.devices[deviceId];
}
