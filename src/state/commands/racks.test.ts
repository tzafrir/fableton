// SS7 racks, Phase 2: the edit vocabulary, through the real store so
// patches, inverses and undo behave exactly as in the app.

import { beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../testing/fixture";
import { expectLegalProject } from "../testing/invariants";
import { deviceParamId, rackChainParamId } from "../../params";
import { DEFAULT_CHAIN_GAIN_DB } from "./racks";
import { GATED_REVERB } from "../../presets/factoryRacks";

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** Adds `n` effects to the fixture track and returns their ids, in order. */
function addEffects(n: number): string[] {
  const before = new Set(f.store.getState().channels[f.trackId]?.chain ?? []);
  for (let i = 0; i < n; i++) {
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter" }));
  }
  return (f.store.getState().channels[f.trackId]?.chain ?? []).filter((id) => !before.has(id));
}

const rackIds = (): string[] => Object.keys(f.store.getState().racks);
const chainOf = (): string[] => [...(f.store.getState().channels[f.trackId]?.chain ?? [])];

describe("addRack", () => {
  it("occupies one chain slot and starts with one empty chain", () => {
    f.store.dispatch(f.commands.addRack(f.trackId));
    const doc = f.store.getState();
    const rackId = rackIds()[0] as string;

    expect(chainOf()).toEqual([rackId]);
    // The rack is NOT a device: the two collections share an id namespace
    // and must stay disjoint, which is what makes a chain slot resolvable.
    expect(doc.devices[rackId]).toBeUndefined();
    const rack = doc.racks[rackId];
    expect(rack?.channelId).toBe(f.trackId);
    expect(rack?.enabled).toBe(true);
    expect(rack?.chains).toHaveLength(1);

    // Chain gain/pan are ordinary registry params seeded at neutral.
    const chainId = rack?.chains[0]?.id as string;
    expect(rack?.chains[0]?.gain).toBe(rackChainParamId(f.trackId, rackId, chainId, "gain"));
    expect(doc.paramValues[rack?.chains[0]?.gain ?? ""]).toBe(DEFAULT_CHAIN_GAIN_DB);
    expect(doc.paramValues[rack?.chains[0]?.pan ?? ""]).toBe(0);
    expectLegalProject(doc);
  });

  it("inserts at an index like any other chain entry", () => {
    const [a, b] = addEffects(2) as [string, string];
    f.store.dispatch(f.commands.addRack(f.trackId, 1));
    const rackId = rackIds()[0] as string;
    expect(chainOf()).toEqual([a, rackId, b]);
  });
});

describe("groupIntoRack / ungroupRack", () => {
  it("wraps the chosen devices at the earliest one's position, keeping order", () => {
    const [a, b, c] = addEffects(3) as [string, string, string];
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [c, a]));
    const rackId = rackIds()[0] as string;

    expect(chainOf()).toEqual([rackId, b]);
    // Chain order follows the CHANNEL chain, not the argument order.
    expect(f.store.getState().racks[rackId]?.chains[0]?.devices).toEqual([a, c]);
    expectLegalProject(f.store.getState());
  });

  it("keeps the device instances themselves — values and lanes survive", () => {
    const [a] = addEffects(1) as [string];
    const paramId = deviceParamId(f.trackId, a, "cutoff");
    f.store.dispatch(f.commands.setParamValues({ [paramId]: 880 }));
    f.store.dispatch(f.commands.addLane(f.trackId, paramId));

    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [a]));
    const doc = f.store.getState();
    // Same instance id, same value, same lane: grouping moves an id between
    // lists, it does not rebuild a device (SS7).
    expect(doc.devices[a]).toBeDefined();
    expect(doc.paramValues[paramId]).toBe(880);
    expect(Object.values(doc.lanes).some((l) => l.paramId === paramId)).toBe(true);
  });

  it("ungroups back into the slot, concatenating chains in order", () => {
    const [a, b] = addEffects(2) as [string, string];
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [a]));
    const rackId = rackIds()[0] as string;
    f.store.dispatch(f.commands.addRackChain(rackId));
    const second = f.store.getState().racks[rackId]?.chains[1]?.id as string;
    const [c] = addEffects(1) as [string];
    f.store.dispatch(f.commands.moveDeviceToChain(rackId, c, second));

    f.store.dispatch(f.commands.ungroupRack(rackId));
    const doc = f.store.getState();
    expect(doc.racks[rackId]).toBeUndefined();
    // Parallel cannot be preserved in a serial chain — stacking is the only
    // reading that keeps every device.
    expect(chainOf()).toEqual([a, c, b]);
    expect(doc.paramValues[rackChainParamId(f.trackId, rackId, second, "gain")]).toBeUndefined();
    expectLegalProject(doc);
  });

  it("is a no-op when no named device is in that channel's chain", () => {
    addEffects(1);
    const before = f.store.getState();
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, ["dev-nope"]));
    expect(f.store.getState().racks).toEqual({});
    expect(f.store.getState().channels[f.trackId]?.chain).toEqual(before.channels[f.trackId]?.chain);
  });
});

describe("chains", () => {
  it("adds and removes chains, taking the removed chain's devices with it", () => {
    const [a] = addEffects(1) as [string];
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [a]));
    const rackId = rackIds()[0] as string;
    f.store.dispatch(f.commands.addRackChain(rackId, "Dry"));
    const doc1 = f.store.getState();
    expect(doc1.racks[rackId]?.chains.map((c) => c.name)).toEqual(["Chain 1", "Dry"]);

    const firstChain = doc1.racks[rackId]?.chains[0]?.id as string;
    f.store.dispatch(f.commands.removeRackChain(rackId, firstChain));
    const doc2 = f.store.getState();
    expect(doc2.racks[rackId]?.chains).toHaveLength(1);
    // A device belongs to exactly one list, so it has nowhere else to go.
    expect(doc2.devices[a]).toBeUndefined();
    expectLegalProject(doc2);
  });

  it("moves a device from the channel chain into a chain, and between chains", () => {
    f.store.dispatch(f.commands.addRack(f.trackId));
    const rackId = rackIds()[0] as string;
    const first = f.store.getState().racks[rackId]?.chains[0]?.id as string;
    f.store.dispatch(f.commands.addRackChain(rackId));
    const second = f.store.getState().racks[rackId]?.chains[1]?.id as string;
    const [a] = addEffects(1) as [string];

    f.store.dispatch(f.commands.moveDeviceToChain(rackId, a, first));
    expect(chainOf()).toEqual([rackId]); // left the channel chain
    expect(f.store.getState().racks[rackId]?.chains[0]?.devices).toEqual([a]);

    f.store.dispatch(f.commands.moveDeviceToChain(rackId, a, second));
    const doc = f.store.getState();
    // Exactly one list holds it — the old chain must not keep a dead id.
    expect(doc.racks[rackId]?.chains[0]?.devices).toEqual([]);
    expect(doc.racks[rackId]?.chains[1]?.devices).toEqual([a]);
    expectLegalProject(doc);
  });

  it("mute, solo, enable and rename are plain flag edits that undo", () => {
    f.store.dispatch(f.commands.addRack(f.trackId));
    const rackId = rackIds()[0] as string;
    const chainId = f.store.getState().racks[rackId]?.chains[0]?.id as string;

    f.store.dispatch(f.commands.setChainMuted(rackId, chainId, true));
    f.store.dispatch(f.commands.setChainSolo(rackId, chainId, true));
    f.store.dispatch(f.commands.setRackEnabled(rackId, false));
    f.store.dispatch(f.commands.renameRack(rackId, "Gated Verb"));
    f.store.dispatch(f.commands.renameRackChain(rackId, chainId, "Gate"));

    const doc = f.store.getState();
    expect(doc.racks[rackId]?.chains[0]?.mute).toBe(true);
    expect(doc.racks[rackId]?.chains[0]?.solo).toBe(true);
    expect(doc.racks[rackId]?.enabled).toBe(false);
    expect(doc.racks[rackId]?.name).toBe("Gated Verb");
    expect(doc.racks[rackId]?.chains[0]?.name).toBe("Gate");

    f.store.undo();
    expect(f.store.getState().racks[rackId]?.chains[0]?.name).toBe("Chain 1");
  });
});

describe("removal", () => {
  it("removeDevices on a rack id takes the rack and its devices", () => {
    const [a] = addEffects(1) as [string];
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [a]));
    const rackId = rackIds()[0] as string;

    f.store.dispatch(f.commands.removeDevices([rackId]));
    const doc = f.store.getState();
    expect(doc.racks[rackId]).toBeUndefined();
    expect(doc.devices[a]).toBeUndefined();
    expect(chainOf()).toEqual([]);
    expectLegalProject(doc);
  });

  it("removing a device that lives INSIDE a rack leaves no dead id", () => {
    const [a] = addEffects(1) as [string];
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [a]));
    const rackId = rackIds()[0] as string;

    f.store.dispatch(f.commands.removeDevices([a]));
    const doc = f.store.getState();
    expect(doc.racks[rackId]?.chains[0]?.devices).toEqual([]);
    expectLegalProject(doc);
  });

  it("deleting the channel deletes its racks — no orphan is left behind", () => {
    const [a] = addEffects(1) as [string];
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [a]));
    f.store.dispatch(f.commands.deleteChannels([f.trackId]));
    const doc = f.store.getState();
    expect(doc.racks).toEqual({});
    expect(doc.devices[a]).toBeUndefined();
    expectLegalProject(doc);
  });

  it("undo restores a deleted rack whole", () => {
    const [a] = addEffects(1) as [string];
    f.store.dispatch(f.commands.groupIntoRack(f.trackId, [a]));
    const rackId = rackIds()[0] as string;
    const before = f.store.getState().racks[rackId];

    f.store.dispatch(f.commands.removeDevices([rackId]));
    f.store.undo();
    expect(f.store.getState().racks[rackId]).toEqual(before);
    expect(f.store.getState().devices[a]).toBeDefined();
    expectLegalProject(f.store.getState());
  });
});

describe("addRackPreset (factory racks)", () => {
  it("builds the Gated Reverb patch in ONE command", () => {
    f.store.dispatch(f.commands.addRackPreset(f.trackId, GATED_REVERB));
    const doc = f.store.getState();
    const rackId = rackIds()[0] as string;
    const rack = doc.racks[rackId];

    expect(rack?.name).toBe("Gated Reverb");
    // A dry chain beside the wet one: the gate cuts the TAIL, and the dry hit
    // has to survive it.
    expect(rack?.chains.map((c) => c.name)).toEqual(["Dry", "Gated Verb"]);
    expect(rack?.chains[0]?.devices).toEqual([]);

    const wet = rack?.chains[1]?.devices ?? [];
    expect(wet).toHaveLength(2);
    expect(wet.map((id) => doc.devices[id]?.definitionId)).toEqual(["core.reverb", "core.gate"]);
    // Seeded values, not descriptor defaults.
    expect(doc.paramValues[deviceParamId(f.trackId, wet[0] as string, "mix")]).toBe(100);

    // The key: the gate opens from the channel's PRE-FX tap — the dry hit —
    // which is the same-channel edge Phase 0 made legal.
    const edge = doc.sidechains.find((e) => e.to.device === wet[1]);
    expect(edge?.from).toEqual({ channel: f.trackId, tap: "preFx" });
    expectLegalProject(doc);
  });

  it("is one undo entry, devices and edge included", () => {
    f.store.dispatch(f.commands.addRackPreset(f.trackId, GATED_REVERB));
    f.store.undo();
    const doc = f.store.getState();
    expect(doc.racks).toEqual({});
    expect(doc.sidechains).toEqual([]);
    expect(Object.values(doc.devices).some((d) => d.definitionId === "core.gate")).toBe(false);
    expectLegalProject(doc);
  });
});
