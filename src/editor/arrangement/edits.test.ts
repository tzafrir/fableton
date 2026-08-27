// The verb math on its own: the clamps and payloads the drag handlers hand to
// the commands. Ghosts and command are computed by the same function, so these
// assertions cover both the preview and what lands in the document.

import { describe, expect, it } from "vitest";
import { MIN_CLIP_TICKS } from "../../types/editor";
import { createDocumentStore } from "../../state";
import { createArrangementScene } from "./scene";
import {
  clampMoveDelta,
  clampRowDelta,
  clampTrimDelta,
  createSpan,
  defaultLoopFor,
  dragTargets,
  loopAfterDrag,
  moveGhosts,
  trimClips,
} from "./edits";
import type { ClipView } from "./geometry";
import { BAR, CLIP_1, CLIP_2, CLIP_3, makeProject } from "./testing/harness";

function scene() {
  return createArrangementScene(createDocumentStore(makeProject()).getState());
}

describe("dragTargets", () => {
  it("acts on the whole selection when the grabbed clip is in it", () => {
    const s = scene();
    expect(dragTargets(s, CLIP_1, [CLIP_1, CLIP_2]).map((c) => c.id)).toEqual([CLIP_1, CLIP_2]);
  });

  it("acts on the grabbed clip alone otherwise", () => {
    const s = scene();
    expect(dragTargets(s, CLIP_1, [CLIP_2]).map((c) => c.id)).toEqual([CLIP_1]);
    expect(dragTargets(s, "nope", [])).toEqual([]);
  });
});

describe("clampRowDelta", () => {
  it("walks back toward zero until the move is legal", () => {
    expect(clampRowDelta(3, (d) => d <= 1)).toBe(1);
    expect(clampRowDelta(-3, (d) => d >= -2)).toBe(-2);
    expect(clampRowDelta(2, () => false)).toBe(0);
  });
});

describe("clampMoveDelta", () => {
  it("keeps the group on tick 0 or later", () => {
    const s = scene();
    const clips = dragTargets(s, CLIP_1, [CLIP_1, CLIP_2]);
    expect(clampMoveDelta(s, clips, -BAR * 5, 0).ticks).toBe(0);
  });

  it("refuses a row delta that would land any clip on a non-track lane", () => {
    const s = scene();
    expect(clampMoveDelta(s, dragTargets(s, CLIP_3, []), 0, 1).rows).toBe(0);
    expect(clampMoveDelta(s, dragTargets(s, CLIP_1, []), 0, 1).rows).toBe(1);
  });

  it("produces ghosts that match the clamped delta", () => {
    const s = scene();
    const clips = dragTargets(s, CLIP_1, []);
    const ghosts = moveGhosts(s, clips, BAR, 1);
    expect(ghosts).toEqual([
      expect.objectContaining({ clipId: CLIP_1, row: 1, start: BAR, length: BAR }),
    ]);
  });
});

describe("clampTrimDelta / trimClips", () => {
  it("floors every clip in the selection at MIN_CLIP_TICKS", () => {
    const s = scene();
    const clips = dragTargets(s, CLIP_1, [CLIP_1, CLIP_3]);
    const delta = clampTrimDelta(clips, "end", -BAR * 4);
    // Clip 3 is the shortest, so it sets the floor for the pair.
    expect(delta).toBe(MIN_CLIP_TICKS - BAR / 2);
    const result = trimClips(s, clips, "end", -BAR * 4);
    for (const span of result.spans) expect(span.length).toBeGreaterThanOrEqual(MIN_CLIP_TICKS);
  });

  it("never moves a left edge before tick 0 or past the clip's own end", () => {
    const s = scene();
    const clips = dragTargets(s, CLIP_1, []);
    expect(clampTrimDelta(clips, "start", -BAR)).toBe(0);
    expect(clampTrimDelta(clips, "start", BAR)).toBe(BAR - MIN_CLIP_TICKS);
  });

  it("slides the loop window with a left trim, as trimClips does", () => {
    const s = scene();
    const base = s.clip(CLIP_1);
    if (base === undefined) throw new Error("fixture");
    const clip: ClipView = { ...base, loop: { start: 960, end: 2880 } };
    const result = trimClips(s, [clip], "start", 960);
    expect(result.ghosts[0]?.loop).toEqual({ start: 0, end: 1920 });
  });
});

describe("loopAfterDrag", () => {
  const clip: ClipView = {
    id: CLIP_1,
    trackId: "t",
    start: 0,
    length: BAR,
    notes: [],
    loop: { start: 960, end: 2880 },
  };

  it("moves one end at a time and keeps at least one tick of loop", () => {
    expect(loopAfterDrag(clip, "loopStart", 480)).toEqual({ start: 1440, end: 2880 });
    expect(loopAfterDrag(clip, "loopStart", BAR)).toEqual({ start: 2879, end: 2880 });
    expect(loopAfterDrag(clip, "loopEnd", -BAR)).toEqual({ start: 960, end: 961 });
  });

  it("slides the window without resizing it, inside the clip", () => {
    expect(loopAfterDrag(clip, "loopBody", 960)).toEqual({ start: 1920, end: BAR });
    expect(loopAfterDrag(clip, "loopBody", BAR * 2)).toEqual({ start: 1920, end: BAR });
    expect(loopAfterDrag(clip, "loopBody", -BAR * 2)).toEqual({ start: 0, end: 1920 });
  });

  it("is null for a clip with no loop", () => {
    const unlooped: ClipView = { ...clip, loop: undefined };
    expect(loopAfterDrag(unlooped, "loopEnd", 100)).toBeNull();
  });

  it("defaults a new brace to the whole clip", () => {
    expect(defaultLoopFor(clip)).toEqual({ start: 0, end: BAR });
  });
});

describe("createSpan (SS10: absolute snap, creation only)", () => {
  const floor = (tick: number) => Math.floor(tick / 960) * 960;
  const ceil = (tick: number) => Math.ceil(tick / 960) * 960;

  it("snaps the start down and the end up", () => {
    expect(createSpan(1000, 2000, floor, ceil, 960)).toEqual({ start: 960, length: 1920 });
  });

  it("works backwards from the anchor", () => {
    expect(createSpan(2000, 1000, floor, ceil, 960)).toEqual({ start: 960, length: 1920 });
  });

  it("floors at one grid division and never before tick 0", () => {
    expect(createSpan(1000, 1010, floor, ceil, 960)).toEqual({ start: 960, length: 960 });
    expect(createSpan(-500, -100, floor, ceil, 960).start).toBe(0);
  });

  it("respects the absolute clip floor when the grid is finer than it", () => {
    const identity = (tick: number) => tick;
    expect(createSpan(0, 1, identity, identity, 1).length).toBe(MIN_CLIP_TICKS);
  });
});
