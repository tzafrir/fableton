// SS6 + SS7 routing commands, run through the real store so patches,
// inverses and `canRun` rejections behave exactly as in the app.

import { beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../testing/fixture";
import { expectLegalProject } from "../testing/invariants";
import { sendParamId, volumeParamId } from "../../params";
import { DEFAULT_SEND_DB } from "./routing";
import type { ChannelId } from "../../types";

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

function addReturn(): ChannelId {
  f.store.dispatch(f.commands.addReturn({ id: "retA" }));
  return "retA";
}

describe("addGroup / addReturn / deleteChannels", () => {
  it("groups a track: output re-points, group sits at the member's row", () => {
    const beforeRow = f.store.getState().channelOrder.indexOf(f.trackId);
    f.store.dispatch(f.commands.addGroup([f.trackId], { id: "g1" }));
    const doc = f.store.getState();
    expect(doc.channels["g1"]?.role).toBe("group");
    expect(doc.channels[f.trackId]?.output).toBe("g1");
    expect(doc.channels["g1"]?.output).toBe(f.masterId);
    expect(doc.channelOrder.indexOf("g1")).toBe(beforeRow);
    expect(doc.paramValues[volumeParamId("g1")]).toBe(0);
  });

  it("grouping a grouped track nests: the new group adopts the common parent", () => {
    f.store.dispatch(f.commands.addGroup([f.trackId], { id: "outer" }));
    f.store.dispatch(f.commands.addGroup([f.trackId], { id: "inner" }));
    const doc = f.store.getState();
    expect(doc.channels[f.trackId]?.output).toBe("inner");
    expect(doc.channels["inner"]?.output).toBe("outer");
  });

  it("rejects grouping the master", () => {
    const result = f.store.dispatch(f.commands.addGroup([f.masterId]));
    expect(result.status).toBe("rejected");
  });

  it("addReturn names returns A, B, ... and routes them to the master", () => {
    f.store.dispatch(f.commands.addReturn());
    f.store.dispatch(f.commands.addReturn());
    const doc = f.store.getState();
    const returns = doc.channelOrder.filter((id) => doc.channels[id]?.role === "return");
    expect(returns.length).toBe(2);
    expect(doc.channels[returns[0] as ChannelId]?.name).toBe("Return A");
    expect(doc.channels[returns[1] as ChannelId]?.name).toBe("Return B");
    // Returns sit above the master.
    expect(doc.channelOrder.indexOf(f.masterId)).toBe(doc.channelOrder.length - 1);
  });

  it("deleting a group re-points members to the group's own output", () => {
    f.store.dispatch(f.commands.addGroup([f.trackId], { id: "g1" }));
    f.store.dispatch(f.commands.deleteChannels(["g1"]));
    const doc = f.store.getState();
    expect(doc.channels["g1"]).toBeUndefined();
    expect(doc.channels[f.trackId]?.output).toBe(f.masterId);
    expect(doc.channelOrder.includes("g1")).toBe(false);
  });

  it("deleting a return removes sends into it plus their param values", () => {
    const ret = addReturn();
    f.store.dispatch(f.commands.setSend(f.trackId, ret));
    f.store.dispatch(f.commands.deleteChannels([ret]));
    const doc = f.store.getState();
    expect(doc.channels[f.trackId]?.sends).toEqual([]);
    expect(doc.paramValues[sendParamId(f.trackId, ret)]).toBeUndefined();
  });

  it("refuses to delete the master (silently keeps it)", () => {
    f.store.dispatch(f.commands.deleteChannels([f.masterId]));
    expect(f.store.getState().channels[f.masterId]?.role).toBe("master");
  });

  it("deletes the lanes of a dying channel (SS11: a lane hangs off its channel)", () => {
    f.store.dispatch(f.commands.addGroup([f.trackId], { id: "g1" }));
    f.store.dispatch(f.commands.addLane("g1", volumeParamId("g1"), { id: "lane-g" }));
    f.store.dispatch(f.commands.addLane(f.trackId, volumeParamId(f.trackId), { id: "lane-t" }));
    f.store.dispatch(f.commands.deleteChannels(["g1"]));
    const doc = f.store.getState();
    // Left behind, `lane-g` would be a lane naming a channel that no longer
    // exists: legal in memory, silently dropped by the codec on the next load.
    expect(doc.lanes["lane-g"]).toBeUndefined();
    expect(doc.lanes["lane-t"]).toBeDefined();
    expectLegalProject(doc);
  });

  it("deleting a nested group stack re-points survivors to the master, in EITHER argument order", () => {
    for (const order of [["inner", "outer"], ["outer", "inner"]] as const) {
      f = makeFixture();
      f.store.dispatch(f.commands.addGroup([f.trackId], { id: "outer" }));
      f.store.dispatch(f.commands.addGroup([f.trackId], { id: "inner" })); // track -> inner -> outer -> master
      f.store.dispatch(f.commands.deleteChannels([...order]));
      const doc = f.store.getState();
      // A single hop would leave the track pointing at whichever group was
      // processed first — a dangling id that bypasses the whole master chain.
      expect(doc.channels[f.trackId]?.output, order.join(",")).toBe(f.masterId);
      expectLegalProject(doc);
    }
  });

  it("delete + undo restores the channel byte-for-byte", () => {
    f.store.dispatch(f.commands.addGroup([f.trackId], { id: "g1" }));
    const before = f.store.getState();
    f.store.dispatch(f.commands.deleteChannels(["g1"]));
    f.store.undo();
    expect(f.store.getState()).toEqual(before);
  });
});

describe("setChannelOutput", () => {
  it("moves a track into a group (one-field edit)", () => {
    f.store.dispatch(f.commands.addGroup([], { id: "g1" }));
    f.store.dispatch(f.commands.setChannelOutput(f.trackId, "g1"));
    expect(f.store.getState().channels[f.trackId]?.output).toBe("g1");
  });

  it("rejects a cycle with an inline hint", () => {
    f.store.dispatch(f.commands.addGroup([f.trackId], { id: "g1" }));
    const result = f.store.dispatch(f.commands.setChannelOutput("g1", f.trackId));
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toMatch(/loop/);
    expect(f.store.getState().channels["g1"]?.output).toBe(f.masterId);
  });

  it("rejects re-routing the master", () => {
    expect(f.store.dispatch(f.commands.setChannelOutput(f.masterId, f.trackId)).status).toBe(
      "rejected",
    );
  });
});

describe("sends", () => {
  it("setSend adds a post send seeded silent; second call only re-taps", () => {
    const ret = addReturn();
    f.store.dispatch(f.commands.setSend(f.trackId, ret));
    let doc = f.store.getState();
    expect(doc.channels[f.trackId]?.sends).toEqual([
      { to: ret, amount: sendParamId(f.trackId, ret), tap: "post" },
    ]);
    expect(doc.paramValues[sendParamId(f.trackId, ret)]).toBe(DEFAULT_SEND_DB);

    // Raise the amount, then re-tap: the value must survive.
    f.store.dispatch(f.commands.setParamValue(sendParamId(f.trackId, ret), -12));
    f.store.dispatch(f.commands.setSend(f.trackId, ret, "pre"));
    doc = f.store.getState();
    expect(doc.channels[f.trackId]?.sends[0]?.tap).toBe("pre");
    expect(doc.paramValues[sendParamId(f.trackId, ret)]).toBe(-12);
  });

  it("rejects a send to itself and a send cycle", () => {
    const ret = addReturn();
    expect(f.store.dispatch(f.commands.setSend(f.trackId, f.trackId)).status).toBe("rejected");
    f.store.dispatch(f.commands.setSend(f.trackId, ret));
    expect(f.store.dispatch(f.commands.setSend(ret, f.trackId)).status).toBe("rejected");
  });

  it("removeSend drops the send and its value", () => {
    const ret = addReturn();
    f.store.dispatch(f.commands.setSend(f.trackId, ret));
    f.store.dispatch(f.commands.removeSend(f.trackId, ret));
    const doc = f.store.getState();
    expect(doc.channels[f.trackId]?.sends).toEqual([]);
    expect(doc.paramValues[sendParamId(f.trackId, ret)]).toBeUndefined();
  });
});

describe("sidechain", () => {
  it("setSidechain replaces any existing edge for the same device+port", () => {
    f.store.dispatch(f.commands.addTrack({ id: "t2" }));
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "fx" }));
    f.store.dispatch(
      f.commands.setSidechain({ from: { channel: "t2", tap: "postFader" }, to: { device: "fx", port: "sc" } }),
    );
    f.store.dispatch(
      f.commands.setSidechain({ from: { channel: "t2", tap: "preFx" }, to: { device: "fx", port: "sc" } }),
    );
    const doc = f.store.getState();
    expect(doc.sidechains).toEqual([
      { from: { channel: "t2", tap: "preFx" }, to: { device: "fx", port: "sc" } },
    ]);
  });

  it("rejects sidechaining the device's own channel", () => {
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "fx" }));
    const result = f.store.dispatch(
      f.commands.setSidechain({
        from: { channel: f.trackId, tap: "postFader" },
        to: { device: "fx", port: "sc" },
      }),
    );
    expect(result.status).toBe("rejected");
  });

  it("removeSidechain clears the edge", () => {
    f.store.dispatch(f.commands.addTrack({ id: "t2" }));
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "fx" }));
    f.store.dispatch(
      f.commands.setSidechain({ from: { channel: "t2", tap: "postFader" }, to: { device: "fx", port: "sc" } }),
    );
    f.store.dispatch(f.commands.removeSidechain("fx"));
    expect(f.store.getState().sidechains).toEqual([]);
  });
});

describe("device chain", () => {
  it("addEffect appends, or inserts at an index", () => {
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "a" }));
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "b" }));
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "c" }, 0));
    const doc = f.store.getState();
    expect(doc.channels[f.trackId]?.chain).toEqual(["c", "a", "b"]);
    expect(doc.devices["c"]?.channelId).toBe(f.trackId);
  });

  it("moveDevice reorders within the chain", () => {
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "a" }));
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "b" }));
    f.store.dispatch(f.commands.moveDevice(f.trackId, "b", 0));
    expect(f.store.getState().channels[f.trackId]?.chain).toEqual(["b", "a"]);
  });

  it("removeDevices drops the device, its sidechain edges and its param values", () => {
    f.store.dispatch(f.commands.addTrack({ id: "t2" }));
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "fx" }));
    f.store.dispatch(f.commands.setParamValue(`chan:${f.trackId}/dev:fx/cutoff`, 500));
    f.store.dispatch(
      f.commands.setSidechain({ from: { channel: "t2", tap: "postFader" }, to: { device: "fx", port: "sc" } }),
    );
    f.store.dispatch(f.commands.removeDevices(["fx"]));
    const doc = f.store.getState();
    expect(doc.devices["fx"]).toBeUndefined();
    expect(doc.channels[f.trackId]?.chain).toEqual([]);
    expect(doc.sidechains).toEqual([]);
    expect(doc.paramValues[`chan:${f.trackId}/dev:fx/cutoff`]).toBeUndefined();
  });

  it("setDeviceEnabled toggles the flag", () => {
    f.store.dispatch(f.commands.addEffect(f.trackId, { definitionId: "core.filter", deviceId: "fx" }));
    f.store.dispatch(f.commands.setDeviceEnabled("fx", false));
    expect(f.store.getState().devices["fx"]?.enabled).toBe(false);
  });

  it("setInstrument swaps the source, carries values, keeps clips", () => {
    const clipsBefore = Object.keys(f.store.getState().clips);
    const oldDevice = f.deviceId;
    f.store.dispatch(
      f.commands.setInstrument(
        f.trackId,
        { definitionId: "core.other-synth", deviceId: "synth2" },
        { cutoff: 880 },
      ),
    );
    const doc = f.store.getState();
    expect(doc.channels[f.trackId]?.source).toEqual({ kind: "instrument", deviceId: "synth2" });
    expect(doc.devices[oldDevice]).toBeUndefined();
    expect(doc.paramValues[`chan:${f.trackId}/dev:synth2/cutoff`]).toBe(880);
    expect(Object.keys(doc.clips)).toEqual(clipsBefore); // SS7: clips untouched
  });
});
