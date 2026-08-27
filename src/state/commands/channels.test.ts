// SS6: tracks/groups/returns/master are one type; `channelOrder` is the
// arrangement's row order and stays a permutation of the channel keys.

import { describe, expect, it } from "vitest";
import { panParamId, volumeParamId } from "../../params";
import { DEFAULT_PAN, DEFAULT_VOLUME_DB } from "../project";
import { BAR, makeFixture, notes } from "../testing/fixture";
import { expectLegalProject } from "../testing/invariants";

describe("channel commands", () => {
  it("addTrack appends above the master and seeds its mixer params", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addTrack({ id: "chan-b" }));
    const doc = f.store.getState();
    expect(doc.channelOrder).toEqual([f.trackId, "chan-b", f.masterId]);
    expect(doc.channels["chan-b"]).toMatchObject({
      role: "track",
      name: "Track 2",
      output: f.masterId,
      mute: false,
      solo: false,
      source: null,
      volume: volumeParamId("chan-b"),
      pan: panParamId("chan-b"),
    });
    expect(doc.paramValues[volumeParamId("chan-b")]).toBe(DEFAULT_VOLUME_DB);
    expect(doc.paramValues[panParamId("chan-b")]).toBe(DEFAULT_PAN);
    expectLegalProject(structuredClone(doc));
  });

  it("addTrack with an instrument mints the device id eagerly", () => {
    const f = makeFixture();
    const result = f.store.dispatch(
      f.commands.addTrack({ id: "chan-b", instrument: { definitionId: "core.poly-synth" } }),
    );
    expect(result.status).toBe("applied");
    const doc = f.store.getState();
    const deviceId = doc.channels["chan-b"]?.source?.deviceId;
    expect(deviceId).toBe("dev-2");
    expect(doc.devices[deviceId ?? ""]).toEqual({
      id: "dev-2",
      definitionId: "core.poly-synth",
      version: 1,
      channelId: "chan-b",
      enabled: true,
    });
  });

  it("addTrack honours an explicit row index and never lands below the master", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addTrack({ id: "top", index: 0 }));
    f.store.dispatch(f.commands.addTrack({ id: "bottom", index: 99 }));
    expect(f.store.getState().channelOrder).toEqual(["top", f.trackId, "bottom", f.masterId]);
  });

  it("addTrack rejects a duplicate channel id", () => {
    const f = makeFixture();
    expect(f.store.dispatch(f.commands.addTrack({ id: f.trackId })).status).toBe("rejected");
  });

  it("deleteTracks takes the track's clips, devices and params with it", () => {
    const f = makeFixture();
    const cutoff = `chan:${f.trackId}/dev:${f.deviceId}/cutoff`;
    f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
    f.store.dispatch(f.commands.setParamValue(cutoff, 900));

    f.store.dispatch(f.commands.deleteTracks([f.trackId]));
    const doc = f.store.getState();
    expect(doc.channels[f.trackId]).toBeUndefined();
    expect(doc.channelOrder).toEqual([f.masterId]);
    expect(doc.clips[f.clipId]).toBeUndefined();
    expect(doc.devices[f.deviceId]).toBeUndefined();
    expect(doc.paramValues[cutoff]).toBeUndefined();
    expect(doc.paramValues[volumeParamId(f.trackId)]).toBeUndefined();
    // The master's own params survive.
    expect(doc.paramValues[volumeParamId(f.masterId)]).toBe(DEFAULT_VOLUME_DB);
    expectLegalProject(structuredClone(doc));
  });

  it("deleteTracks refuses the master", () => {
    const f = makeFixture();
    expect(f.store.dispatch(f.commands.deleteTracks([f.masterId]))).toEqual({
      status: "rejected",
      reason: "The master channel cannot be deleted.",
    });
  });

  it("deleteTracks re-points anything that fed the removed channel", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addTrack({ id: "group" }));
    f.store.dispatch(
      f.commands.custom("Route Into Group", (doc) => {
        const group = doc.channels["group"];
        const track = doc.channels[f.trackId];
        if (group !== undefined) group.role = "group";
        if (track !== undefined) track.output = "group";
      }),
    );
    f.store.dispatch(f.commands.deleteTracks(["group"]));
    expect(f.store.getState().channels[f.trackId]?.output).toBe(f.masterId);
    expectLegalProject(structuredClone(f.store.getState()));
  });

  it("deleteTracks drops sends pointing at the removed channel, and their params", () => {
    const f = makeFixture();
    const sendParam = `chan:${f.trackId}/send:return`;
    f.store.dispatch(f.commands.addTrack({ id: "return" }));
    f.store.dispatch(
      f.commands.custom("Add Send", (doc) => {
        const track = doc.channels[f.trackId];
        if (track === undefined) return;
        track.sends.push({ to: "return", amount: sendParam, tap: "post" });
        doc.paramValues[sendParam] = -12;
      }),
    );
    f.store.dispatch(f.commands.deleteTracks(["return"]));
    const doc = f.store.getState();
    expect(doc.channels[f.trackId]?.sends).toEqual([]);
    expect(doc.paramValues[sendParam]).toBeUndefined();
    expectLegalProject(structuredClone(doc));
  });

  it("moveChannel reorders rows and keeps the master last", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addTrack({ id: "b" }));
    f.store.dispatch(f.commands.addTrack({ id: "c" }));
    f.store.dispatch(f.commands.moveChannel(f.trackId, 2));
    expect(f.store.getState().channelOrder).toEqual(["b", "c", f.trackId, f.masterId]);
    f.store.dispatch(f.commands.moveChannel("c", 0));
    expect(f.store.getState().channelOrder).toEqual(["c", "b", f.trackId, f.masterId]);
    f.store.dispatch(f.commands.moveChannel("b", 99));
    expect(f.store.getState().channelOrder.at(-1)).toBe(f.masterId);
  });

  it("moveChannel to the same row is a noop", () => {
    const f = makeFixture();
    expect(f.store.dispatch(f.commands.moveChannel(f.trackId, 0)).status).toBe("noop");
    expect(f.store.dispatch(f.commands.moveChannel("gone", 0)).status).toBe("noop");
  });

  it("mute, solo, rename and color write the channel's document fields", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.setChannelMuted(f.trackId, true));
    f.store.dispatch(f.commands.setChannelSolo(f.trackId, true));
    f.store.dispatch(f.commands.renameChannel(f.trackId, "Lead"));
    f.store.dispatch(f.commands.setChannelColor(f.trackId, "#abcdef"));
    expect(f.store.getState().channels[f.trackId]).toMatchObject({
      mute: true,
      solo: true,
      name: "Lead",
      color: "#abcdef",
    });
  });

  it("deleting a track and undoing restores every last param value", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.createClip({ id: "c2", trackId: f.trackId, start: BAR, length: BAR }));
    const before = structuredClone(f.store.getState());
    f.store.dispatch(f.commands.deleteTracks([f.trackId]));
    f.store.undo();
    expect(structuredClone(f.store.getState())).toEqual(before);
  });
});
