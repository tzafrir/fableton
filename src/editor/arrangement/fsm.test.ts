// SS9's gesture contract, verb by verb, driven by SYNTHETIC POINTER SEQUENCES
// (SS15) against the real engine, the real scene and the real commands:
//
//   * a drag previews with ghosts and writes NOTHING to the document until it
//     is released;
//   * a release commits EXACTLY ONE command;
//   * `Esc` / `pointercancel` abort with zero document traffic;
//   * snapping is relative for moves and trims, absolute for creation, and
//     `Alt` bypasses it.

import { describe, expect, it } from "vitest";
import type { MovePreview } from "./dragMove";
import type { TrimPreview } from "./dragTrim";
import type { CreatePreview } from "./dragCreate";
import type { LoopPreview } from "./dragLoop";
import type { MarqueePreview } from "./dragMarquee";
import { MIN_CLIP_TICKS } from "../../types/editor";
import { BAR, CLIP_1, CLIP_2, CLIP_3, TRACK_A, TRACK_B, createHarness } from "./testing/harness";

/** One beat at the fixture's fixed 1/4 grid. */
const BEAT = 960;
/** Pixels per beat at the fixture zoom (0.05 px/tick). */
const BEAT_PX = 48;
const BAR_PX = BEAT_PX * 4;

const CLIP_1_BODY: readonly [number, number] = [100, 20];
const CLIP_1_EDGE_R: readonly [number, number] = [190, 20];
const CLIP_1_EDGE_L: readonly [number, number] = [2, 20];
const EMPTY_TRACK_A: readonly [number, number] = [600, 20];

describe("hover (SS10: the cursor reflects the zone)", () => {
  it("resolves body / edges / empty lane and sets the cursor", () => {
    const h = createHarness();
    h.move(...CLIP_1_BODY);
    expect(h.engine.hover).toMatchObject({ kind: "clip", clipId: CLIP_1, zone: "body" });

    h.move(...CLIP_1_EDGE_L);
    expect(h.engine.hover).toMatchObject({ zone: "edgeL" });
    expect(h.engine.cursor).toBe("ew-resize");

    h.move(...EMPTY_TRACK_A);
    expect(h.engine.hover).toMatchObject({ kind: "lane", row: 0, isTrack: true });
    expect(h.engine.cursor).toBe("crosshair");

    h.move(600, 100); // the master lane
    expect(h.engine.hover).toMatchObject({ kind: "lane", row: 2, isTrack: false });
  });
});

describe("selection clicks (SS10: Shift adds, Ctrl toggles)", () => {
  it("selects on click without dispatching anything", () => {
    const h = createHarness();
    h.down(...CLIP_1_BODY);
    h.up(...CLIP_1_BODY);
    expect(h.selection.ids()).toEqual([CLIP_1]);
    expect(h.dispatched).toHaveLength(0);
  });

  it("adds with Shift and toggles with the primary modifier", () => {
    const h = createHarness();
    h.down(...CLIP_1_BODY);
    h.up(...CLIP_1_BODY);
    h.down(500, 20, { shift: true });
    h.up(500, 20, { shift: true });
    expect([...h.selection.ids()].sort()).toEqual([CLIP_1, CLIP_2]);
    h.down(500, 20, { primary: true });
    h.up(500, 20, { primary: true });
    expect(h.selection.ids()).toEqual([CLIP_1]);
  });

  it("does not promote to a drag under the threshold", () => {
    const h = createHarness();
    h.down(...CLIP_1_BODY);
    h.move(102, 20);
    expect(h.engine.phase).toBe("pending");
    h.up(102, 20);
    expect(h.dispatched).toHaveLength(0);
    expect(h.clip(CLIP_1)?.start).toBe(0);
  });

  it("double-clicking a clip opens the piano roll on it (SS18-M1)", () => {
    const h = createHarness();
    h.down(100, 20, {}, 2);
    h.up(100, 20, {}, 2);
    expect(h.opened).toEqual([CLIP_1]);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("move (one command, relative snap)", () => {
  it("previews with ghosts and leaves the document alone until release", () => {
    const h = createHarness();
    h.down(...CLIP_1_BODY);
    h.move(150, 20);
    const preview = h.engine.preview as MovePreview;
    expect(preview.deltaTicks).toBe(BEAT); // 50 px -> 1000 ticks -> snapped
    expect(preview.ghosts).toEqual([
      expect.objectContaining({ clipId: CLIP_1, row: 0, start: BEAT, length: BAR }),
    ]);
    expect(h.clip(CLIP_1)?.start).toBe(0);
    expect(h.dispatched).toHaveLength(0);

    h.up(150, 20);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.label).toBe("Move Clips");
    expect(h.clip(CLIP_1)?.start).toBe(BEAT);
  });

  it("bypasses snapping while Alt is held (SS10)", () => {
    const h = createHarness();
    h.drag(CLIP_1_BODY, [150, 20], { alt: true });
    expect(h.clip(CLIP_1)?.start).toBe(1000);
  });

  it("moves the clip to another track when the drag crosses a lane", () => {
    const h = createHarness();
    h.drag(CLIP_1_BODY, [100, 60]);
    expect(h.clip(CLIP_1)?.trackId).toBe(TRACK_B);
    expect(h.clip(CLIP_1)?.start).toBe(0);
  });

  it("refuses to drop a clip on a non-track lane, and then commits nothing", () => {
    const h = createHarness();
    h.drag([220, 60], [220, 100]); // clip 3, dragged onto the master lane
    expect(h.clip(CLIP_3)?.trackId).toBe(TRACK_B);
    expect(h.dispatched).toHaveLength(0);
  });

  it("never lets a clip start before tick 0", () => {
    const h = createHarness();
    h.drag(CLIP_1_BODY, [-400, 20]);
    expect(h.clip(CLIP_1)?.start).toBe(0);
  });

  it("moves a whole multi-selection with ONE command", () => {
    const h = createHarness();
    h.down(...CLIP_1_BODY);
    h.up(...CLIP_1_BODY);
    h.down(500, 20, { shift: true });
    h.up(500, 20, { shift: true });
    h.drag(CLIP_1_BODY, [100 + BEAT_PX, 20]);
    expect(h.dispatched).toHaveLength(1);
    expect(h.clip(CLIP_1)?.start).toBe(BEAT);
    expect(h.clip(CLIP_2)?.start).toBe(BAR * 2 + BEAT);
  });

  it("commits nothing when the drag ends where it started", () => {
    const h = createHarness();
    h.down(...CLIP_1_BODY);
    h.move(110, 20);
    h.move(100, 20);
    h.up(100, 20);
    expect(h.dispatched).toHaveLength(0);
    expect(h.store.canUndo()).toBe(false);
  });

  // The duplicate flavour of the same gesture: a copy stacked exactly on its
  // original is invisible, shadows the original in hit-testing and doubles
  // that bar at playback — so it is not an edit either.
  it("commits nothing when a DUPLICATE drag ends where it started", () => {
    const h = createHarness();
    const before = Object.keys(h.store.getState().clips).length;
    h.down(...CLIP_1_BODY, { primary: true });
    h.move(110, 20, { primary: true });
    h.move(100, 20, { primary: true });
    h.up(100, 20, { primary: true });
    expect(h.dispatched).toHaveLength(0);
    expect(h.store.canUndo()).toBe(false);
    expect(Object.keys(h.store.getState().clips)).toHaveLength(before);
  });
});

describe("duplicate (Cmd/Ctrl + drag)", () => {
  it("copies the selection and selects the copy", () => {
    const h = createHarness();
    h.drag(CLIP_1_BODY, [100 + 192, 20], { primary: true });
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.label).toBe("Duplicate Clips");
    const clips = Object.values(h.store.getState().clips);
    expect(clips).toHaveLength(4);
    const copy = clips.find((clip) => clip.id !== CLIP_1 && clip.start === BAR && clip.trackId === TRACK_A);
    expect(copy).toBeDefined();
    expect(h.selection.ids()).toEqual([copy?.id]);
    // The original is untouched.
    expect(h.clip(CLIP_1)?.start).toBe(0);
  });
});

describe("trim (absolute spans, moving edge only)", () => {
  it("extends the right edge", () => {
    const h = createHarness();
    h.drag(CLIP_1_EDGE_R, [190 + BEAT_PX, 20]);
    expect(h.dispatched[0]?.label).toBe("Trim Clips");
    expect(h.clip(CLIP_1)).toMatchObject({ start: 0, length: BAR + BEAT });
  });

  it("moves the left edge and rewrites clip-relative note ticks", () => {
    const h = createHarness();
    h.drag(CLIP_1_EDGE_L, [2 + BEAT_PX, 20]);
    const clip = h.clip(CLIP_1);
    expect(clip).toMatchObject({ start: BEAT, length: BAR - BEAT });
    // The note that fell outside the new window is dropped (accepted v1 loss);
    // the survivor slid by the same delta.
    expect(clip?.notes.map((note) => [note.id, note.start])).toEqual([["note-2", 1920 - BEAT]]);
  });

  it("undo restores the notes a left trim dropped", () => {
    const h = createHarness();
    h.drag(CLIP_1_EDGE_L, [2 + BEAT_PX, 20]);
    h.store.undo();
    expect(h.store.getState().clips[CLIP_1]?.notes).toHaveLength(2);
  });

  it("floors the length at MIN_CLIP_TICKS", () => {
    const h = createHarness();
    h.drag(CLIP_1_EDGE_R, [-500, 20]);
    expect(h.clip(CLIP_1)?.length).toBe(MIN_CLIP_TICKS);
  });

  it("previews the ghost span without touching the document", () => {
    const h = createHarness();
    h.down(...CLIP_1_EDGE_R);
    h.move(190 + BEAT_PX, 20);
    const preview = h.engine.preview as TrimPreview;
    expect(preview.edge).toBe("end");
    expect(preview.spans).toEqual([{ id: CLIP_1, start: 0, length: BAR + BEAT }]);
    expect(h.clip(CLIP_1)?.length).toBe(BAR);
  });

  // The ghost has to show the repeats WHILE the edge is being dragged; a
  // brace that only appeared on release would make the gesture a guess.
  it("previews the loop brace a grow will add, and commits it in the same command", () => {
    const h = createHarness();
    h.down(...CLIP_1_EDGE_R);
    h.move(190 + BAR_PX, 20);
    const preview = h.engine.preview as TrimPreview;
    expect(preview.ghosts[0]?.loop).toEqual({ start: 0, end: BAR });
    expect(h.clip(CLIP_1)?.loop).toBeUndefined(); // still just a preview
    h.up(190 + BAR_PX, 20);
    expect(h.dispatched).toHaveLength(1);
    expect(h.clip(CLIP_1)).toMatchObject({ length: BAR * 2, loop: { start: 0, end: BAR } });
  });

  it("trims a whole multi-selection with one command", () => {
    const h = createHarness();
    h.selection.set([CLIP_1, CLIP_2]);
    h.drag(CLIP_1_EDGE_R, [190 + BEAT_PX, 20]);
    expect(h.dispatched).toHaveLength(1);
    expect(h.clip(CLIP_1)?.length).toBe(BAR + BEAT);
    expect(h.clip(CLIP_2)?.length).toBe(BAR + BEAT);
  });
});

describe("create (absolute snap, SS10)", () => {
  it("drags out a new clip on an empty lane and selects it", () => {
    const h = createHarness();
    h.down(...EMPTY_TRACK_A); // tick 12000
    h.move(700, 20); // tick 14000
    const preview = h.engine.preview as CreatePreview;
    expect(preview).toMatchObject({ trackId: TRACK_A, start: 11520, length: 2880 });
    expect(Object.keys(h.store.getState().clips)).toHaveLength(3);

    h.up(700, 20);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.label).toBe("Create Clip");
    const created = Object.values(h.store.getState().clips).find((clip) => clip.start === 11520);
    expect(created).toMatchObject({ trackId: TRACK_A, length: 2880 });
    expect(h.selection.ids()).toEqual([created?.id]);
  });

  it("creates leftwards too, anchored on the pointerdown", () => {
    const h = createHarness();
    h.drag(EMPTY_TRACK_A, [552, 20]); // back to tick 11040
    const created = Object.values(h.store.getState().clips).find((clip) => clip.id !== CLIP_1 && clip.id !== CLIP_2 && clip.id !== CLIP_3);
    expect(created).toMatchObject({ start: 10560, length: 1920 });
  });

  it("floors a tiny drag at one grid division", () => {
    const h = createHarness();
    h.drag(EMPTY_TRACK_A, [604, 20]);
    const created = Object.values(h.store.getState().clips).find((clip) => clip.start === 11520);
    expect(created?.length).toBe(BEAT);
  });

  it("double-click on an empty lane creates a one-bar clip", () => {
    const h = createHarness();
    h.down(600, 20, {}, 2);
    h.up(600, 20, {}, 2);
    expect(h.dispatched).toHaveLength(1);
    const created = Object.values(h.store.getState().clips).find((clip) => clip.start === 11520);
    expect(created?.length).toBe(BAR);
  });

  it("a plain click on an empty lane clears the selection and edits nothing", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.down(...EMPTY_TRACK_A);
    h.up(...EMPTY_TRACK_A);
    expect(h.selection.size).toBe(0);
    expect(h.dispatched).toHaveLength(0);
  });

  it("does not create on a non-track lane", () => {
    const h = createHarness();
    h.drag([600, 100], [700, 100]);
    expect(h.dispatched).toHaveLength(0);
    expect(Object.keys(h.store.getState().clips)).toHaveLength(3);
  });
});

describe("marquee (selection is not undoable)", () => {
  it("selects by rect-intersect and dispatches nothing", () => {
    const h = createHarness();
    h.down(600, 20, { shift: true });
    h.move(200, 60, { shift: true });
    const preview = h.engine.preview as MarqueePreview;
    expect(preview.hits.length).toBeGreaterThan(0);
    h.up(200, 60, { shift: true });
    expect([...h.selection.ids()].sort()).toEqual([CLIP_2, CLIP_3]);
    expect(h.dispatched).toHaveLength(0);
    expect(h.store.canUndo()).toBe(false);
  });

  it("adds to the existing selection with Shift", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.drag([600, 20], [200, 60], { shift: true });
    expect([...h.selection.ids()].sort()).toEqual([CLIP_1, CLIP_2, CLIP_3]);
  });

  // SS10's `Pending` row: "`Ctrl` toggles". Covered members drop out, new
  // ones come in — the third branch of the same rule as Shift/plain.
  it("TOGGLES with Ctrl/Cmd: covered members leave, uncovered ones join", () => {
    const h = createHarness();
    h.selection.set([CLIP_1, CLIP_2]);
    h.drag([600, 20], [200, 60], { primary: true });
    // The rectangle covers CLIP_2 (already selected -> removed) and CLIP_3
    // (not selected -> added); CLIP_1 is outside it and untouched.
    expect([...h.selection.ids()].sort()).toEqual([CLIP_1, CLIP_3]);
    expect(h.dispatched).toHaveLength(0);
  });

  // A Shift/Ctrl click that merely MISSED a clip is still an additive click:
  // wiping the selection would throw away what the user was adding to.
  it("keeps an additive selection when a modified click misses every clip", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.down(600, 100, { shift: true });
    h.up(600, 100, { shift: true });
    expect(h.selection.ids()).toEqual([CLIP_1]);

    h.down(600, 100, { primary: true });
    h.up(600, 100, { primary: true });
    expect(h.selection.ids()).toEqual([CLIP_1]);

    // ...while a PLAIN click on empty space still clears (SS10 `Pending`).
    h.down(600, 100);
    h.up(600, 100);
    expect(h.selection.ids()).toEqual([]);
  });

  it("restores the selection it started from when cancelled", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.down(600, 20, { shift: true });
    h.move(200, 60, { shift: true });
    h.engine.cancel();
    expect(h.selection.ids()).toEqual([CLIP_1]);
  });

  it("marquees on a non-track lane without a modifier", () => {
    const h = createHarness();
    h.drag([600, 100], [200, 100]);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("loop brace", () => {
  function looped() {
    const h = createHarness();
    h.store.dispatch(h.commands.setClipLoop(CLIP_1, { start: 0, end: 1920 }));
    return h;
  }

  it("drags the right handle and commits one setClipLoop", () => {
    const h = looped();
    const x = h.xOfTick(1920);
    h.drag([x, 2], [x + BEAT_PX, 2]);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.label).toBe("Set Clip Loop");
    expect(h.clip(CLIP_1)?.loop).toEqual({ start: 0, end: 1920 + BEAT });
  });

  it("slides the whole window when the brace body is dragged", () => {
    const h = looped();
    h.drag([h.xOfTick(960), 2], [h.xOfTick(960) + BEAT_PX, 2]);
    expect(h.clip(CLIP_1)?.loop).toEqual({ start: BEAT, end: 1920 + BEAT });
  });

  it("clamps the window to the clip and commits nothing when it cannot move", () => {
    const h = looped();
    h.drag([h.xOfTick(0), 2], [-200, 2]);
    expect(h.clip(CLIP_1)?.loop).toEqual({ start: 0, end: 1920 });
    expect(h.dispatched).toHaveLength(0);
  });

  it("clamps the loop end to the clip length", () => {
    const h = looped();
    const x = h.xOfTick(1920);
    h.drag([x, 2], [x + 1000, 2]);
    expect(h.clip(CLIP_1)?.loop).toEqual({ start: 0, end: BAR });
  });

  it("previews the new brace before release", () => {
    const h = looped();
    const x = h.xOfTick(1920);
    h.down(x, 2);
    h.move(x + BEAT_PX, 2);
    const preview = h.engine.preview as LoopPreview;
    expect(preview.loop).toEqual({ start: 0, end: 1920 + BEAT });
    expect(h.clip(CLIP_1)?.loop).toEqual({ start: 0, end: 1920 });
  });
});

describe("abort (SS9: zero document traffic)", () => {
  it("Esc reverts a live move", () => {
    const h = createHarness();
    h.down(...CLIP_1_BODY);
    h.move(300, 60);
    h.engine.cancel();
    expect(h.engine.phase).toBe("idle");
    expect(h.dispatched).toHaveLength(0);
    expect(h.clip(CLIP_1)).toMatchObject({ start: 0, trackId: TRACK_A });
  });

  it("pointercancel aborts a create the same way", () => {
    const h = createHarness();
    h.down(...EMPTY_TRACK_A);
    h.move(700, 20);
    h.engine.pointerCancel({
      pointerId: 1,
      point: { xPx: 700, yPx: 20, tick: 14000, row: 0.5 },
      button: 0,
      buttons: 0,
      modifiers: { shift: false, alt: false, ctrl: false, meta: false, primary: false },
    });
    expect(h.dispatched).toHaveLength(0);
    expect(Object.keys(h.store.getState().clips)).toHaveLength(3);
  });
});
