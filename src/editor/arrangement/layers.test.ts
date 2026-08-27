// SS9's culling rule, arrangement skin: "Content culls to the viewport: notes
// are kept sorted by start tick, and the visible window is found by binary
// search — O(visible) per frame, comfortably inside the 2,000-note budget"
// (SS2). Assertions read the recording 2D context's call log, so they measure
// what the layer actually submits per frame rather than pixels.

import { beforeAll, describe, expect, it } from "vitest";
import type { LayerFrame } from "../../types/render";
import type { Note, Project } from "../../types";
import { createDocumentStore } from "../../state";
import { fakeContextOf, installFakeCanvas2D } from "../kit/testing/fakeCanvas";
import { createViewport } from "../kit";
import { DEFAULT_THEME } from "./constants";
import { createArrangementClipsLayer } from "./layers";
import { createArrangementScene } from "./scene";
import { BAR, CLIP_1, MASTER, TRACK_A, TRACK_B, makeProject } from "./testing/harness";

beforeAll(() => {
  installFakeCanvas2D();
});

const WIDTH_PX = 1000;
const HEIGHT_PX = 400;
/** Wide enough for the note miniature to draw at all (MIN_NOTE_LANE_PX). */
const LANE_HEIGHT_PX = 48;

function notesEvery(count: number, step: number): Note[] {
  const out: Note[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ id: `n${String(i)}`, start: i * step, dur: step, pitch: 40 + (i % 40), vel: 100 });
  }
  return out;
}

/** One long clip on track A holding `notes`, everything else as the fixture. */
function projectWithLongClip(notes: Note[], length: number): Project {
  const base = makeProject();
  return {
    ...base,
    clips: {
      [CLIP_1]: { ...base.clips[CLIP_1]!, start: 0, length, notes },
    },
  };
}

function setup(project: Project, pxPerTick = 0.05) {
  const store = createDocumentStore(project);
  const scene = createArrangementScene(store.getState());
  const viewport = createViewport({
    pxPerTick,
    pxPerRow: LANE_HEIGHT_PX,
    widthPx: WIDTH_PX,
    heightPx: HEIGHT_PX,
    limits: { maxTick: Number.MAX_SAFE_INTEGER, maxRow: 8 },
  });
  const layer = createArrangementClipsLayer({ scene, theme: DEFAULT_THEME });
  const canvas = document.createElement("canvas");
  const raw = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  const recorder = fakeContextOf(canvas);
  const frame: LayerFrame = {
    ctx: raw,
    viewport,
    widthPx: WIDTH_PX,
    heightPx: HEIGHT_PX,
    dpr: 1,
    time: 0,
  };
  const draw = () => {
    recorder.reset();
    layer.draw(frame);
    return recorder;
  };
  return { viewport, draw };
}

/** x coordinates of every `fillRect` narrow enough to be a note miniature. */
function noteRectXs(recorder: ReturnType<typeof fakeContextOf>): number[] {
  return recorder
    .callsOf("fillRect")
    .filter((call) => Number(call.args[3]) <= 3) // note miniatures are <= 3 px tall
    .map((call) => Number(call.args[0]));
}

describe("clip note miniatures cull to the viewport", () => {
  const NOTE_COUNT = 1200;
  const STEP = 120; // a 1/32 note
  const LENGTH = NOTE_COUNT * STEP;

  it("draws only the notes on screen, wherever the viewport is scrolled", () => {
    const { viewport, draw } = setup(projectWithLongClip(notesEvery(NOTE_COUNT, STEP), LENGTH));

    for (const scroll of [0, LENGTH / 2, LENGTH - 20_000]) {
      viewport.setScroll(scroll, 0);
      const xs = noteRectXs(draw());
      expect(xs.length, `notes drawn at scroll ${String(scroll)}`).toBeGreaterThan(0);
      // Every submitted rect is on screen (a note straddling the left edge
      // may start up to its own width — 120 ticks = 6 px — off it); nothing
      // off-screen is submitted at all.
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(-10);
        expect(x).toBeLessThanOrEqual(WIDTH_PX + 1);
      }
      // ...and the count is O(visible), not O(clip): a 1000 px window at
      // 0.05 px/tick spans 20,000 ticks = ~167 notes.
      expect(xs.length).toBeLessThan(200);
    }
  });

  it("keeps the miniature's pitch scale stable while scrolling", () => {
    const { viewport, draw } = setup(projectWithLongClip(notesEvery(NOTE_COUNT, STEP), LENGTH));
    // The vertical scale comes from the WHOLE clip's pitch range, so a note of
    // the same pitch lands on the same y wherever the window is.
    viewport.setScroll(0, 0);
    const first = draw()
      .callsOf("fillRect")
      .filter((c) => Number(c.args[3]) <= 3)
      .map((c) => Number(c.args[1]));
    viewport.setScroll(LENGTH / 2, 0);
    const later = draw()
      .callsOf("fillRect")
      .filter((c) => Number(c.args[3]) <= 3)
      .map((c) => Number(c.args[1]));
    // Pitches repeat every 40 notes, so both windows cover the same 40 rows.
    expect(new Set(first).size).toBe(new Set(later).size);
    expect(Math.min(...first)).toBe(Math.min(...later));
    expect(Math.max(...first)).toBe(Math.max(...later));
  });

  // SS2's headline budget, measured rather than assumed.
  it("stays O(visible) with 2,000 notes in view-sized windows", () => {
    const { viewport, draw } = setup(projectWithLongClip(notesEvery(2000, STEP), 2000 * STEP));
    viewport.setScroll(100_000, 0);
    const recorder = draw();
    expect(noteRectXs(recorder).length).toBeLessThan(200);
    // The whole frame — clip bodies, borders, labels, miniatures — stays in
    // the low hundreds of canvas calls with 2,000 notes in the document.
    expect(recorder.calls.length).toBeLessThan(600);
  });
});

describe("loop repeat separators", () => {
  function projectWithLoop(loop: { start: number; end: number }, length: number): Project {
    const base = makeProject();
    return {
      ...base,
      clips: {
        [CLIP_1]: { ...base.clips[CLIP_1]!, start: 0, length, loop, notes: [] },
      },
    };
  }

  it("draws one separator per visible repeat, not per repeat in the clip", () => {
    const length = BAR * 64;
    const { viewport, draw } = setup(projectWithLoop({ start: 0, end: BAR }, length));
    viewport.setScroll(0, 0);
    const strokes = draw().callsOf("stroke").length;
    // A 1000 px window at 0.05 px/tick shows ~5 bars, so ~5 separators (plus
    // the clip border) — never the 63 repeats the clip contains.
    expect(strokes).toBeLessThan(12);
  });

  it("skips separators entirely when the loop is shorter than a readable cell", () => {
    // Reachable with one drag: `loopAfterDrag`/`setClipLoop` clamp the loop
    // end to `start + 1`, i.e. a ONE TICK period over a 64-bar clip.
    const length = BAR * 64;
    const { viewport, draw } = setup(projectWithLoop({ start: 0, end: 1 }, length));
    viewport.setScroll(0, 0);
    const recorder = draw();
    // Only the clip's own border strokes; no 120,000-iteration separator loop.
    expect(recorder.callsOf("stroke").length).toBeLessThan(4);
    expect(recorder.calls.length).toBeLessThan(40);
  });
});

describe("lane culling", () => {
  it("visits only the lanes inside the visible row range", () => {
    const base = makeProject();
    const { viewport, draw } = setup(base);
    // Three lanes at 48 px each fit in the 400 px canvas; scroll past them and
    // nothing is drawn at all.
    viewport.setLimits({ maxRow: 64 });
    viewport.setScroll(0, 40);
    expect(draw().calls.length).toBe(0);
    expect([TRACK_A, TRACK_B, MASTER]).toHaveLength(3);
  });
});
