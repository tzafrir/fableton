import { describe, expect, it } from "vitest";
import { BAR, QUARTER, makeFixture, notes } from "./testing/fixture";
import {
  channelAtRow,
  channelsInOrder,
  clipsForEngine,
  clipsOfTrack,
  notesOfClip,
  rowOfChannel,
  tracksInOrder,
} from "./select";

describe("document readers", () => {
  it("clipsOfTrack returns one track's clips in start order", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addTrack({ id: "other" }));
    f.store.dispatch(f.commands.createClip({ id: "late", trackId: f.trackId, start: BAR * 2, length: BAR }));
    f.store.dispatch(f.commands.createClip({ id: "mid", trackId: f.trackId, start: BAR, length: BAR }));
    f.store.dispatch(f.commands.createClip({ id: "elsewhere", trackId: "other", start: 0, length: BAR }));

    const doc = f.store.getState();
    expect(clipsOfTrack(doc, f.trackId).map((clip) => clip.id)).toEqual([f.clipId, "mid", "late"]);
    expect(clipsOfTrack(doc, "other").map((clip) => clip.id)).toEqual(["elsewhere"]);
    expect(clipsOfTrack(doc, "nobody")).toEqual([]);
  });

  it("notesOfClip hands back the sorted array the culling binary-searches", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, notes([[QUARTER, 72], [0, 60]])));
    const doc = f.store.getState();
    expect(notesOfClip(doc, f.clipId).map((note) => note.start)).toEqual([0, QUARTER]);
    expect(notesOfClip(doc, "gone")).toEqual([]);
  });

  it("row helpers agree with channelOrder (SS9 row convention)", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addTrack({ id: "b" }));
    const doc = f.store.getState();
    expect(channelsInOrder(doc).map((channel) => channel.id)).toEqual([f.trackId, "b", f.masterId]);
    expect(tracksInOrder(doc).map((channel) => channel.id)).toEqual([f.trackId, "b"]);
    expect(rowOfChannel(doc, "b")).toBe(1);
    expect(channelAtRow(doc, 1)?.id).toBe("b");
    expect(channelAtRow(doc, 9)).toBeUndefined();
    expect(rowOfChannel(doc, "gone")).toBe(-1);
  });

  it("clipsForEngine hands the scheduler MUTABLE copies, in start order", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
    f.store.dispatch(f.commands.createClip({ id: "late", trackId: f.trackId, start: BAR, length: BAR }));

    const clips = clipsForEngine(f.store.getState());
    expect(clips.map((clip) => clip.id)).toEqual([f.clipId, "late"]);
    // Writing into what the engine got must be possible (M0's event source
    // takes plain clips) and must NOT reach the document.
    const first = clips[0];
    if (first === undefined) throw new Error("no clip");
    first.notes.push({ id: "scratch", start: 0, dur: 10, pitch: 60, vel: 100 });
    first.start = 12345;
    expect(f.store.getState().clips[f.clipId]?.notes).toHaveLength(1);
    expect(f.store.getState().clips[f.clipId]?.start).toBe(0);
  });

  it("clipsForEngine drops clips on muted tracks", () => {
    const f = makeFixture();
    expect(clipsForEngine(f.store.getState())).toHaveLength(1);
    f.store.dispatch(f.commands.setChannelMuted(f.trackId, true));
    expect(clipsForEngine(f.store.getState())).toHaveLength(0);
  });
});
