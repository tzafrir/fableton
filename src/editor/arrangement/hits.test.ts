// The hover model: which clip, which zone, and in which order the testers run.
// SS10's answer to "elementFromPoint can't express edge zones or tolerance" —
// it is all ordinary math against the model.

import { describe, expect, it } from "vitest";
import type { EditorPoint } from "../../types/gesture";
import { createDocumentStore, projectCommands } from "../../state";
import { createViewport, modifiers } from "../kit";
import { createClipHitTester, createHitTesters, createLaneHitTester, isClipHit, isLaneHit } from "./hits";
import { createArrangementScene } from "./scene";
import { BAR, CLIP_1, CLIP_2, MASTER, TRACK_A, makeProject } from "./testing/harness";

function setup() {
  const store = createDocumentStore(makeProject());
  const scene = createArrangementScene(store.getState());
  const viewport = createViewport({ pxPerTick: 0.05, pxPerRow: 40, widthPx: 1000, heightPx: 200 });
  const testers = createHitTesters(scene, viewport);
  const at = (x: number, y: number): EditorPoint => ({ xPx: x, yPx: y, tick: viewport.tAt(x), row: viewport.rowAt(y) });
  const hit = (x: number, y: number) => {
    for (const tester of [...testers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
      const found = tester.hitTest(at(x, y), modifiers({}));
      if (found !== null) return found;
    }
    return null;
  };
  return { store, scene, viewport, hit, at, testers };
}

describe("hit testers", () => {
  it("puts clips above lanes", () => {
    const { testers } = setup();
    expect(testers.map((t) => t.id)).toEqual(["arrangement.clip", "arrangement.lane"]);
    expect(testers[0]?.priority).toBeGreaterThan(testers[1]?.priority ?? 0);
  });

  it("returns a clip hit with its zone, track and row", () => {
    const { hit } = setup();
    const found = hit(100, 20);
    expect(isClipHit(found)).toBe(true);
    expect(found).toMatchObject({ kind: "clip", clipId: CLIP_1, trackId: TRACK_A, row: 0, zone: "body" });
  });

  it("falls through to the lane in the gaps between clips", () => {
    const { hit } = setup();
    const found = hit(300, 20); // tick 6000: between clip 1 and clip 2
    expect(isLaneHit(found)).toBe(true);
    expect(found).toMatchObject({ kind: "lane", row: 0, channelId: TRACK_A, isTrack: true });
  });

  it("marks the master lane as not a track (no clips may land there)", () => {
    const { hit } = setup();
    expect(hit(300, 100)).toMatchObject({ kind: "lane", channelId: MASTER, isTrack: false });
  });

  it("hits nothing below the last lane", () => {
    const { hit } = setup();
    expect(hit(300, 190)).toBeNull();
  });

  it("keeps the edge zones INSIDE the clip (SS10), so the lane stays clickable", () => {
    const { hit } = setup();
    // Clip 2 starts at x = 384.
    expect(hit(385, 20)).toMatchObject({ clipId: CLIP_2, zone: "edgeL" });
    expect(hit(382, 20)).toMatchObject({ kind: "lane" });
  });

  it("gives the topmost clip to overlapping clips", () => {
    const { store, scene, viewport, at } = setup();
    // Move clip 2 on top of clip 1; the later-painted clip must win the hit.
    const result = store.dispatch(projectCommands.moveClips([CLIP_2], { ticks: -BAR * 2 + 480, tracks: 0 }));
    if (result.status !== "applied") throw new Error(result.status);
    scene.update(store.getState(), result.patches);
    const tester = createClipHitTester(scene, viewport);
    expect(tester.hitTest(at(100, 20), modifiers({}))).toMatchObject({ clipId: CLIP_2 });
  });

  it("never reports a lane for a row that has no channel", () => {
    const { scene, viewport, at } = setup();
    const tester = createLaneHitTester(scene);
    expect(tester.hitTest(at(10, viewport.pxPerRow * 3 + 5), modifiers({}))).toBeNull();
  });
});
