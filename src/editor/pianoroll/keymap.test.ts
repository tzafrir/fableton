// SS10's keyboard map. "Every action goes through the same commands the mouse
// uses" — so every assertion below checks the dispatched command label AND the
// document, exactly like the FSM tests do.

import { describe, expect, it } from "vitest";
import { FINE_NUDGE_TICKS, MIN_NOTE_TICKS } from "../../types/editor";
import { duplicateDelta } from "./keymap";
import { createHarness, type Harness } from "./testing/harness";

const GRID = 240;

function selectN1(h: Harness): void {
  h.down(12, h.yMid(60));
  h.up(12, h.yMid(60));
}

function selectBoth(h: Harness): void {
  selectN1(h);
  h.down(h.x(960) + 12, h.yMid(64), { shift: true });
  h.up(h.x(960) + 12, h.yMid(64), { shift: true });
}

describe("transpose", () => {
  it("up/down move by one semitone and audition at the new pitch", () => {
    const h = createHarness();
    selectN1(h);
    h.audition.reset();

    expect(h.key("ArrowUp")).toBe(true);
    expect(h.labels()).toEqual(["Move Notes"]);
    expect(h.note("n1")?.pitch).toBe(61);
    expect(h.audition.ons()).toEqual([61]);

    h.key("ArrowDown");
    expect(h.note("n1")?.pitch).toBe(60);
  });

  it("Shift moves by an octave", () => {
    const h = createHarness();
    selectN1(h);
    h.key("ArrowUp", { shift: true });
    expect(h.note("n1")?.pitch).toBe(72);
    h.key("ArrowDown", { shift: true });
    expect(h.note("n1")?.pitch).toBe(60);
  });

  it("clamps the group at the ends of the range", () => {
    const h = createHarness({ notes: [{ id: "top", start: 0, dur: 240, pitch: 127, vel: 100 }] });
    h.ctx.selection.set(["top"]);
    expect(h.key("ArrowUp")).toBe(true);
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("top")?.pitch).toBe(127);
  });

  it("passes the key through when nothing is selected", () => {
    const h = createHarness();
    expect(h.key("ArrowUp")).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("horizontal moves", () => {
  it("left/right move by the current grid", () => {
    const h = createHarness();
    selectN1(h);
    h.key("ArrowRight");
    expect(h.note("n1")?.start).toBe(GRID);
    h.key("ArrowLeft");
    expect(h.note("n1")?.start).toBe(0);
    expect(h.labels()).toEqual(["Move Notes", "Move Notes"]);
  });

  it("Shift is a 1/64-note fine nudge", () => {
    const h = createHarness();
    selectN1(h);
    h.key("ArrowRight", { shift: true });
    expect(h.note("n1")?.start).toBe(FINE_NUDGE_TICKS);
  });

  it("follows a fixed grid override", () => {
    const h = createHarness();
    h.grid.setSettings({ mode: "fixed", denominator: 4 });
    selectN1(h);
    h.key("ArrowRight");
    expect(h.note("n1")?.start).toBe(960);
  });

  it("clamps at tick 0 instead of going negative", () => {
    const h = createHarness();
    selectN1(h);
    expect(h.key("ArrowLeft")).toBe(true);
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("n1")?.start).toBe(0);
  });
});

describe("Alt+left/right: shorten / lengthen", () => {
  it("lengthens by the grid", () => {
    const h = createHarness();
    selectN1(h);
    h.key("ArrowRight", { alt: true });
    expect(h.labels()).toEqual(["Resize Notes"]);
    expect(h.note("n1")).toMatchObject({ start: 0, dur: 480 + GRID });
  });

  it("shortens by the grid, flooring at a 1/128 note", () => {
    const h = createHarness({ notes: [{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }] });
    h.ctx.selection.set(["n1"]);
    h.key("ArrowLeft", { alt: true });
    expect(h.note("n1")?.dur).toBe(MIN_NOTE_TICKS);
  });
});

describe("Cmd/Ctrl chords", () => {
  it("A selects every note in the clip", () => {
    const h = createHarness();
    expect(h.key("a", { primary: true })).toBe(true);
    expect(new Set(h.selectionIds())).toEqual(new Set(["n1", "n2"]));
    expect(h.dispatched).toHaveLength(0);
  });

  it("D duplicates the selection immediately after itself", () => {
    const h = createHarness();
    selectN1(h);
    h.key("d", { primary: true });
    expect(h.labels()).toEqual(["Duplicate Notes"]);
    expect(h.notes().filter((n) => n.pitch === 60).map((n) => n.start)).toEqual([0, 480]);
  });

  it("D uses the whole selection's span", () => {
    const h = createHarness();
    selectBoth(h);
    h.key("d", { primary: true });
    // n1 starts at 0, n2 ends at 1440: the copies land a full span later.
    expect(h.notes().map((n) => n.start).sort((a, b) => a - b)).toEqual([0, 960, 1440, 2400]);
  });

  it("U quantizes starts to the grid, leaving durations alone", () => {
    const h = createHarness({ notes: [{ id: "n1", start: 100, dur: 350, pitch: 60, vel: 100 }] });
    h.ctx.selection.set(["n1"]);
    h.key("u", { primary: true });
    expect(h.labels()).toEqual(["Quantize"]);
    expect(h.note("n1")).toMatchObject({ start: 0, dur: 350 });
  });

  it("leaves plain arrow keys alone when the primary modifier is held", () => {
    const h = createHarness();
    selectN1(h);
    expect(h.key("ArrowRight", { primary: true })).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("delete / mute / Esc", () => {
  it("Delete removes the selection and clears it", () => {
    const h = createHarness();
    selectN1(h);
    h.key("Delete");
    expect(h.labels()).toEqual(["Delete Note"]);
    expect(h.notes().map((n) => n.id)).toEqual(["n2"]);
    expect(h.selectionIds()).toEqual([]);
  });

  it("Backspace does the same", () => {
    const h = createHarness();
    selectN1(h);
    h.key("Backspace");
    expect(h.notes()).toHaveLength(1);
  });

  it("0 toggles mute for the selection", () => {
    const h = createHarness();
    selectBoth(h);
    h.key("0", undefined, "Digit0");
    expect(h.labels()).toEqual(["Mute Notes"]);
    expect(h.notes().every((n) => n.muted === true)).toBe(true);

    h.key("0", undefined, "Digit0");
    expect(h.labels()).toEqual(["Mute Notes", "Unmute Notes"]);
    expect(h.notes().every((n) => n.muted === true)).toBe(false);
  });

  it("mutes when the selection is mixed", () => {
    const h = createHarness({
      notes: [
        { id: "a", start: 0, dur: 240, pitch: 60, vel: 100, muted: true },
        { id: "b", start: 240, dur: 240, pitch: 60, vel: 100 },
      ],
    });
    h.ctx.selection.set(["a", "b"]);
    h.key("0");
    expect(h.notes().every((n) => n.muted === true)).toBe(true);
  });

  it("Esc clears the selection and stops the keyboard audition", () => {
    const h = createHarness();
    selectN1(h);
    h.key("ArrowUp");
    h.audition.reset();
    expect(h.key("Escape")).toBe(true);
    expect(h.selectionIds()).toEqual([]);
    expect(h.audition.offs()).toEqual([61]);
  });
});

describe("duplicateDelta", () => {
  it("is the selection's own span", () => {
    expect(duplicateDelta([{ id: "a", start: 480, dur: 240, pitch: 60, vel: 1 }], 240)).toBe(240);
    expect(
      duplicateDelta(
        [
          { id: "a", start: 0, dur: 240, pitch: 60, vel: 1 },
          { id: "b", start: 960, dur: 480, pitch: 60, vel: 1 },
        ],
        240,
      ),
    ).toBe(1440);
  });

  it("never returns zero", () => {
    expect(duplicateDelta([], 240)).toBe(0);
    expect(duplicateDelta([{ id: "a", start: 0, dur: 0, pitch: 60, vel: 1 }], 240)).toBe(240);
  });
});
