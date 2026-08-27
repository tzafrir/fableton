// SS10: "Every action goes through the same commands the mouse uses — the
// keyboard is a first-class client of the editor, not a bolt-on." Same engine,
// same commands, same one-gesture-one-undo-entry rule.

import { describe, expect, it } from "vitest";
import type { KeyInput, Modifiers } from "../../types/gesture";
import { FINE_NUDGE_TICKS, MIN_CLIP_TICKS } from "../../types/editor";
import { BAR, CLIP_1, CLIP_2, CLIP_3, TRACK_B, createHarness } from "./testing/harness";

const BEAT = 960;

const NONE: Modifiers = { shift: false, alt: false, ctrl: false, meta: false, primary: false };
const key = (k: string, mods: Partial<Modifiers> = {}): KeyInput => ({
  key: k,
  modifiers: { ...NONE, ...mods },
});

describe("delete", () => {
  it("deletes the selection with one command and clears it", () => {
    const h = createHarness();
    h.selection.set([CLIP_1, CLIP_2]);
    expect(h.engine.keyDown(key("Delete"))).toBe(true);
    expect(h.dispatched).toHaveLength(1);
    expect(Object.keys(h.store.getState().clips)).toEqual([CLIP_3]);
    expect(h.selection.size).toBe(0);
  });

  it("passes the key through when nothing is selected", () => {
    const h = createHarness();
    expect(h.engine.keyDown(key("Backspace"))).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("nudging", () => {
  it("moves by the current grid, and by the fine step with Shift", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.engine.keyDown(key("ArrowRight"));
    expect(h.clip(CLIP_1)?.start).toBe(BEAT);
    h.engine.keyDown(key("ArrowLeft", { shift: true }));
    expect(h.clip(CLIP_1)?.start).toBe(BEAT - FINE_NUDGE_TICKS);
  });

  it("moves between lanes with the vertical arrows", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.engine.keyDown(key("ArrowDown"));
    expect(h.clip(CLIP_1)?.trackId).toBe(TRACK_B);
  });

  it("cannot push a clip past the first lane", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.engine.keyDown(key("ArrowUp"));
    expect(h.clip(CLIP_1)?.trackId).not.toBe(TRACK_B);
    expect(h.store.canUndo()).toBe(false); // the command was a no-op
  });

  it("Alt + arrows lengthen and shorten by the grid", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.engine.keyDown(key("ArrowRight", { alt: true }));
    expect(h.clip(CLIP_1)?.length).toBe(BAR + BEAT);
    h.engine.keyDown(key("ArrowLeft", { alt: true }));
    expect(h.clip(CLIP_1)?.length).toBe(BAR);
  });

  it("never shortens below the clip floor", () => {
    const h = createHarness({ gridDenominator: 1 });
    h.selection.set([CLIP_3]);
    h.engine.keyDown(key("ArrowLeft", { alt: true }));
    expect(h.clip(CLIP_3)?.length).toBe(MIN_CLIP_TICKS);
  });
});

describe("Cmd/Ctrl + D — duplicate immediately after itself", () => {
  it("offsets the copy by the span of the selection and selects it", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.engine.keyDown(key("d", { primary: true }));
    const copy = Object.values(h.store.getState().clips).find((clip) => clip.start === BAR && clip.trackId === h.clip(CLIP_1)?.trackId);
    expect(copy).toBeDefined();
    expect(copy?.length).toBe(BAR);
    expect(h.selection.ids()).toEqual([copy?.id]);
  });
});

describe("Cmd/Ctrl + A", () => {
  it("selects every clip and dispatches nothing", () => {
    const h = createHarness();
    expect(h.engine.keyDown(key("a", { primary: true }))).toBe(true);
    expect([...h.selection.ids()].sort()).toEqual([CLIP_1, CLIP_2, CLIP_3]);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("Cmd/Ctrl + E — split at the playhead", () => {
  it("splits one selected clip in two", () => {
    const h = createHarness();
    h.playhead = 1920;
    h.selection.set([CLIP_1]);
    expect(h.engine.keyDown(key("e", { primary: true }))).toBe(true);
    const clips = Object.values(h.store.getState().clips);
    expect(clips).toHaveLength(4);
    expect(h.clip(CLIP_1)).toMatchObject({ start: 0, length: 1920 });
    const right = clips.find((clip) => clip.start === 1920 && clip.trackId === h.clip(CLIP_1)?.trackId);
    expect(right?.length).toBe(1920);
    // The note at 1920 moved to the new clip's origin.
    expect(right?.notes.map((note) => note.start)).toEqual([0]);
  });

  it("splits several clips as ONE undo entry", () => {
    const h = createHarness();
    h.store.dispatch(h.commands.moveClips([CLIP_3], { ticks: -(BAR - BEAT), tracks: 0 }));
    const before = h.store.history().length;
    h.playhead = 1920;
    h.selection.set([CLIP_1, CLIP_3]);
    h.engine.keyDown(key("e", { primary: true }));
    expect(Object.keys(h.store.getState().clips)).toHaveLength(5);
    expect(h.store.history().length).toBe(before + 1);
    expect(h.store.undoLabel()).toBe("Split Clips");
    h.store.undo();
    expect(Object.keys(h.store.getState().clips)).toHaveLength(3);
  });

  it("skips a looped clip instead of dispatching a command that would be rejected", () => {
    const h = createHarness();
    h.store.dispatch(h.commands.setClipLoop(CLIP_1, { start: 0, end: 1920 }));
    h.playhead = 1920;
    h.selection.set([CLIP_1]);
    expect(h.engine.keyDown(key("e", { primary: true }))).toBe(false);
    expect(Object.keys(h.store.getState().clips)).toHaveLength(3);
  });

  it("does nothing when the playhead is outside every selected clip", () => {
    const h = createHarness();
    h.playhead = BAR * 10;
    h.selection.set([CLIP_1]);
    expect(h.engine.keyDown(key("e", { primary: true }))).toBe(false);
  });
});

describe("Cmd/Ctrl + L — loop brace", () => {
  it("loops the whole clip, then clears it", () => {
    const h = createHarness();
    h.selection.set([CLIP_1]);
    h.engine.keyDown(key("l", { primary: true }));
    expect(h.clip(CLIP_1)?.loop).toEqual({ start: 0, end: BAR });
    h.engine.keyDown(key("l", { primary: true }));
    expect(h.clip(CLIP_1)?.loop).toBeUndefined();
  });

  it("loops the not-yet-looped clips of a mixed selection, as one entry", () => {
    const h = createHarness();
    h.store.dispatch(h.commands.setClipLoop(CLIP_1, { start: 0, end: 960 }));
    const before = h.store.history().length;
    h.selection.set([CLIP_1, CLIP_2, CLIP_3]);
    h.engine.keyDown(key("l", { primary: true }));
    expect(h.clip(CLIP_1)?.loop).toEqual({ start: 0, end: 960 }); // untouched
    expect(h.clip(CLIP_2)?.loop).toEqual({ start: 0, end: BAR });
    expect(h.clip(CLIP_3)?.loop).toEqual({ start: 0, end: BAR / 2 });
    expect(h.store.history().length).toBe(before + 1);
  });
});

describe("Escape", () => {
  it("clears the selection and consumes the key only when there is one", () => {
    const h = createHarness();
    expect(h.engine.keyDown(key("Escape"))).toBe(false);
    h.selection.set([CLIP_1]);
    expect(h.engine.keyDown(key("Escape"))).toBe(true);
    expect(h.selection.size).toBe(0);
  });
});
