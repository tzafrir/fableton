// SS9 culling + SS13 targeted updates: the scene must find the visible clips
// by binary search, and must re-index only the lanes a patch actually touched.

import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../../state";
import { createArrangementScene } from "./scene";
import { BAR, CLIP_1, CLIP_2, CLIP_3, MASTER, TRACK_A, TRACK_B, makeProject } from "./testing/harness";
import { projectCommands } from "../../state";

function setup() {
  const store = createDocumentStore(makeProject());
  const scene = createArrangementScene(store.getState());
  const apply = (command: Parameters<typeof store.dispatch>[0]) => {
    const result = store.dispatch(command);
    if (result.status !== "applied") throw new Error(`dispatch: ${result.status}`);
    return scene.update(store.getState(), result.patches);
  };
  return { store, scene, apply };
}

describe("rows follow channelOrder (the frozen row convention)", () => {
  it("indexes one row per channel, tracks and master alike", () => {
    const { scene } = setup();
    expect(scene.rowCount()).toBe(3);
    expect(scene.rowOfChannel(TRACK_A)).toBe(0);
    expect(scene.rowOfChannel(TRACK_B)).toBe(1);
    expect(scene.rowOfChannel(MASTER)).toBe(2);
    expect(scene.isTrackRow(0)).toBe(true);
    expect(scene.isTrackRow(2)).toBe(false);
    expect(scene.channelAt(1)?.name).toBe("Track B");
  });

  it("groups clips onto their track's row, sorted by start", () => {
    const { scene } = setup();
    expect(scene.rows[0]?.clips.map((c) => c.id)).toEqual([CLIP_1, CLIP_2]);
    expect(scene.rows[1]?.clips.map((c) => c.id)).toEqual([CLIP_3]);
    expect(scene.rows[2]?.clips).toEqual([]);
    expect(scene.rowOfClip(CLIP_3)).toBe(1);
  });
});

describe("culling", () => {
  it("returns only clips overlapping the window", () => {
    const { scene } = setup();
    expect(scene.clipsInRange(0, 0, BAR).map((c) => c.id)).toEqual([CLIP_1]);
    expect(scene.clipsInRange(0, BAR, BAR * 2).map((c) => c.id)).toEqual([]);
    expect(scene.clipsInRange(0, 0, BAR * 4).map((c) => c.id)).toEqual([CLIP_1, CLIP_2]);
  });

  it("includes a clip that starts before the window and reaches into it", () => {
    const { scene } = setup();
    expect(scene.clipsInRange(0, BAR - 1, BAR + 100).map((c) => c.id)).toEqual([CLIP_1]);
  });

  it("finds the clip under a tick, and nothing in the gaps", () => {
    const { scene } = setup();
    expect(scene.clipAtTick(0, 10)?.id).toBe(CLIP_1);
    expect(scene.clipAtTick(0, BAR)).toBeUndefined();
    expect(scene.clipAtTick(0, BAR * 2 + 5)?.id).toBe(CLIP_2);
  });

  it("intersects a (row, tick) rectangle for the marquee", () => {
    const { scene } = setup();
    expect(scene.clipsIntersecting(0, 0, 0, BAR - 1).map((c) => c.id)).toEqual([CLIP_1]);
    const both = scene.clipsIntersecting(0, 1, 0, BAR * 2).map((c) => c.id);
    // The end tick is INCLUSIVE, so a marquee reaching clip 2's first tick
    // catches it — the same way its left-most pixel column is inside the rect.
    expect([...both].sort()).toEqual([CLIP_1, CLIP_2, CLIP_3]);
  });

  it("still selects under a marquee dragged straight down (zero tick width)", () => {
    const { scene } = setup();
    expect(scene.clipsIntersecting(0, 1, 100, 100).map((c) => c.id)).toEqual([CLIP_1]);
  });

  it("tracks the content extent", () => {
    const { scene } = setup();
    expect(scene.contentEndTick()).toBe(BAR * 3);
  });
});

describe("targeted updates (SS13)", () => {
  it("reports a clip edit as a clip change only", () => {
    const { scene, apply } = setup();
    const change = apply(projectCommands.moveClips([CLIP_1], { ticks: BAR, tracks: 0 }));
    expect(change).toEqual({ structure: false, clips: true, song: false });
    expect(scene.clip(CLIP_1)?.start).toBe(BAR);
    // The lane was re-sorted, not just mutated in place.
    expect(scene.rows[0]?.clips.map((c) => c.id)).toEqual([CLIP_1, CLIP_2]);
  });

  it("re-indexes BOTH lanes when a clip changes track", () => {
    const { scene, apply } = setup();
    apply(projectCommands.moveClips([CLIP_1], { ticks: 0, tracks: 1 }));
    expect(scene.rowOfClip(CLIP_1)).toBe(1);
    expect(scene.rows[0]?.clips.map((c) => c.id)).toEqual([CLIP_2]);
    expect(scene.rows[1]?.clips.map((c) => c.id)).toEqual([CLIP_1, CLIP_3]);
  });

  it("forgets a deleted clip", () => {
    const { scene, apply } = setup();
    apply(projectCommands.deleteClips([CLIP_2]));
    expect(scene.clip(CLIP_2)).toBeUndefined();
    expect(scene.rowOfClip(CLIP_2)).toBe(-1);
    expect(scene.rows[0]?.clips.map((c) => c.id)).toEqual([CLIP_1]);
    expect(scene.contentEndTick()).toBe(BAR + BAR / 2);
  });

  it("rebuilds the lane set when a track is added", () => {
    const { scene, apply } = setup();
    const change = apply(projectCommands.addTrack({ id: "chan-c", name: "Track C", index: 1 }));
    expect(change.structure).toBe(true);
    expect(scene.rowCount()).toBe(4);
    expect(scene.rowOfChannel("chan-c")).toBe(1);
    expect(scene.rowOfClip(CLIP_3)).toBe(2);
  });

  it("reports a tempo or signature edit as a song change", () => {
    const { apply } = setup();
    expect(apply(projectCommands.setTempo(140))).toEqual({
      structure: false,
      clips: false,
      song: true,
    });
  });

  it("falls back to a full rebuild when the patch stream is unknown", () => {
    const { store, scene } = setup();
    const next = { ...store.getState(), clips: {} } as ReturnType<typeof store.getState>;
    const change = scene.update(next, undefined);
    expect(change.structure).toBe(true);
    expect(scene.rows[0]?.clips).toEqual([]);
  });
});
