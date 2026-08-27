// SS10's gesture FSM, one describe per row of the table, driven by synthetic
// pointer sequences (SS15). Every test asserts three things where they apply:
// what the PREVIEW showed, which ONE command was dispatched, and what `Esc`
// left behind (the "revert" column: zero document traffic).

import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD_PX } from "../../types/gesture";
import { DEFAULT_NOTE_VELOCITY, MIN_NOTE_TICKS } from "../../types/editor";
import { HANDLER_IDS, type DupPreview, type MarqueePreview, type MovePreview, type PaintPreview, type ResizePreview, type VelocityPreview } from "./preview";
import { createHarness } from "./testing/harness";

const GRID = 240; // 1/16 note at the harness's zoom
const PX_PER_GRID = 12;

describe("Idle", () => {
  it("hovers without touching the document", () => {
    const h = createHarness();
    h.move(12, h.yMid(60));
    expect(h.engine.phase).toBe("idle");
    expect(h.dispatched).toHaveLength(0);
  });

  it("Esc clears the selection", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.up(12, h.yMid(60));
    expect(h.selectionIds()).toEqual(["n1"]);
    h.esc();
    expect(h.selectionIds()).toEqual([]);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("Pending", () => {
  it("selects on click; Shift adds, Ctrl/Cmd toggles", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.up(12, h.yMid(60));
    expect(h.selectionIds()).toEqual(["n1"]);

    h.down(h.x(960) + 12, h.yMid(64), { shift: true });
    h.up(h.x(960) + 12, h.yMid(64), { shift: true });
    expect(h.selectionIds()).toEqual(["n1", "n2"]);

    h.down(12, h.yMid(60), { primary: true });
    h.up(12, h.yMid(60), { primary: true });
    expect(h.selectionIds()).toEqual(["n2"]);
    expect(h.dispatched).toHaveLength(0);
  });

  it("clears the selection when clicking empty grid", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.up(12, h.yMid(60));
    h.down(400, h.yMid(66));
    h.up(400, h.yMid(66));
    expect(h.selectionIds()).toEqual([]);
  });

  it("stays a click below the 3 px threshold", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(12 + DRAG_THRESHOLD_PX, h.yMid(60));
    expect(h.engine.phase).toBe("pending");
    h.up(12 + DRAG_THRESHOLD_PX, h.yMid(60));
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("n1")?.start).toBe(0);
  });

  it("promotes per zone", () => {
    const cases: readonly (readonly [string, number, number, string])[] = [
      ["body", 12, 0, HANDLER_IDS.move],
      ["left edge", 2, 0, HANDLER_IDS.resizeL],
      ["right edge", 22, 0, HANDLER_IDS.resizeR],
    ];
    for (const [, x, , id] of cases) {
      const h = createHarness();
      h.down(x, h.yMid(60));
      h.move(x + 10, h.yMid(60));
      expect(h.engine.phase).toBe("dragging");
      expect(h.engine.activeHandlerId).toBe(id);
    }

    const dup = createHarness();
    dup.down(12, dup.yMid(60), { alt: true });
    dup.move(24, dup.yMid(60), { alt: true });
    expect(dup.engine.activeHandlerId).toBe(HANDLER_IDS.dup);

    const marquee = createHarness();
    marquee.down(400, marquee.yMid(66));
    marquee.move(420, marquee.yMid(62));
    expect(marquee.engine.activeHandlerId).toBe(HANDLER_IDS.marquee);
  });

  it("double-clicking empty grid creates a grid-length note", () => {
    const h = createHarness();
    const x = h.x(2000);
    h.down(x, h.yMid(66), undefined, 2);
    h.up(x, h.yMid(66), undefined, 2);
    expect(h.labels()).toEqual(["Add Note"]);
    const created = h.notes().find((note) => note.pitch === 66);
    // Creation is the one ABSOLUTE snap (SS10): 2000 floors to 1920.
    expect(created).toMatchObject({ start: 1920, dur: GRID, pitch: 66, vel: DEFAULT_NOTE_VELOCITY });
  });
});

describe("DragMove", () => {
  it("ghosts at a snapped delta and commits one move command", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(12 + PX_PER_GRID, h.yMid(60));
    const preview = h.engine.preview as MovePreview;
    expect(preview.kind).toBe("move");
    expect(preview.deltaTicks).toBe(GRID);
    expect(preview.ghosts).toEqual([
      { id: "n1", start: GRID, dur: 480, pitch: 60, vel: 100 },
    ]);
    expect(h.note("n1")?.start).toBe(0); // no document traffic mid-drag

    h.up(12 + PX_PER_GRID, h.yMid(60));
    expect(h.labels()).toEqual(["Move Notes"]);
    expect(h.note("n1")?.start).toBe(GRID);
  });

  it("moves RELATIVELY, preserving an off-grid offset", () => {
    const h = createHarness({ notes: [{ id: "off", start: 100, dur: 480, pitch: 60, vel: 100 }] });
    h.drag([h.x(100) + 12, h.yMid(60)], [h.x(100) + 12 + PX_PER_GRID + 3, h.yMid(60)]);
    // 15 px = 300 ticks -> snapped delta 240; the 100-tick offset survives.
    expect(h.note("off")?.start).toBe(340);
  });

  it("bypasses snapping while Alt is held mid-drag", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(12 + 5, h.yMid(60), { alt: true });
    h.up(12 + 5, h.yMid(60), { alt: true });
    expect(h.note("n1")?.start).toBe(100); // 5 px = 100 ticks, unsnapped
  });

  it("transposes by whole rows and auditions on pitch change", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(12, h.yMid(60) - 16);
    expect((h.engine.preview as MovePreview).deltaPitch).toBe(1);
    expect(h.audition.ons()).toEqual([61]);

    h.move(12, h.yMid(60) - 32);
    expect(h.audition.ons()).toEqual([61, 62]);
    expect(h.audition.offs()).toEqual([61]);

    // Back to the original row: the audition stops, no new pitch sounds.
    h.move(12, h.yMid(60));
    expect(h.audition.ons()).toEqual([61, 62]);
    expect(h.audition.offs()).toEqual([61, 62]);

    h.up(12, h.yMid(60) - 16);
    expect(h.note("n1")?.pitch).toBe(61);
  });

  it("moves the whole selection when the drag starts on a member", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.up(12, h.yMid(60));
    h.down(h.x(960) + 12, h.yMid(64), { shift: true });
    h.up(h.x(960) + 12, h.yMid(64), { shift: true });

    h.drag([12, h.yMid(60)], [12 + PX_PER_GRID, h.yMid(60)]);
    expect(h.note("n1")?.start).toBe(GRID);
    expect(h.note("n2")?.start).toBe(960 + GRID);
    expect(h.labels()).toEqual(["Move Notes"]);
  });

  it("clamps the group so no note starts before 0", () => {
    const h = createHarness();
    h.drag([12, h.yMid(60)], [12 - 10 * PX_PER_GRID, h.yMid(60)]);
    expect(h.note("n1")?.start).toBe(0);
    expect(h.dispatched).toHaveLength(0); // clamped to nothing = no command
  });

  it("commits nothing when the snapped delta is zero", () => {
    const h = createHarness();
    h.drag([12, h.yMid(60)], [16, h.yMid(60)]);
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("n1")?.start).toBe(0);
  });

  it("Esc reverts with zero document traffic and stops the audition", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(12 + PX_PER_GRID, h.yMid(60) - 16);
    expect(h.audition.ons()).toEqual([61]);
    h.esc();
    expect(h.engine.phase).toBe("idle");
    expect(h.engine.preview).toBeNull();
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("n1")).toMatchObject({ start: 0, pitch: 60 });
    expect(h.audition.offs()).toEqual([61]);
  });

  it("pointercancel is Esc", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(12 + PX_PER_GRID, h.yMid(60));
    h.cancelPointer();
    expect(h.engine.phase).toBe("idle");
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("n1")?.start).toBe(0);
  });
});

describe("DragResizeL / DragResizeR", () => {
  it("stretches the right edge and leaves the start alone", () => {
    const h = createHarness();
    h.down(22, h.yMid(60));
    h.move(22 + PX_PER_GRID, h.yMid(60));
    const preview = h.engine.preview as ResizePreview;
    expect(preview.edge).toBe("r");
    expect(preview.spans).toEqual([{ id: "n1", start: 0, dur: 480 + GRID }]);
    h.up(22 + PX_PER_GRID, h.yMid(60));
    expect(h.labels()).toEqual(["Resize Notes"]);
    expect(h.note("n1")).toMatchObject({ start: 0, dur: 720 });
  });

  it("moves the left edge and leaves the END anchored", () => {
    const h = createHarness({ notes: [{ id: "n1", start: 960, dur: 480, pitch: 60, vel: 100 }] });
    const x = h.x(960);
    h.drag([x + 2, h.yMid(60)], [x + 2 + PX_PER_GRID, h.yMid(60)]);
    const note = h.note("n1");
    expect(note?.start).toBe(960 + GRID);
    expect((note?.start ?? 0) + (note?.dur ?? 0)).toBe(1440);
  });

  it("floors the length at a 1/128 note", () => {
    const h = createHarness();
    h.drag([22, h.yMid(60)], [22 - 100, h.yMid(60)]);
    expect(h.note("n1")?.dur).toBe(MIN_NOTE_TICKS);
  });

  it("Esc reverts", () => {
    const h = createHarness();
    h.down(22, h.yMid(60));
    h.move(22 + PX_PER_GRID, h.yMid(60));
    h.esc();
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("n1")?.dur).toBe(480);
  });
});

describe("DragDup (Alt+body)", () => {
  it("commits duplicate+move as one command", () => {
    const h = createHarness();
    h.down(12, h.yMid(60), { alt: true });
    h.move(12 + PX_PER_GRID, h.yMid(60), { alt: true });
    const preview = h.engine.preview as DupPreview;
    expect(preview.mode).toBe("duplicate");
    // Ghosts are COPIES: they carry no id.
    expect(preview.ghosts[0]).toMatchObject({ id: null, start: GRID, pitch: 60 });
    expect(h.notes()).toHaveLength(2);

    h.up(12 + PX_PER_GRID, h.yMid(60), { alt: true });
    expect(h.labels()).toEqual(["Duplicate Notes"]);
    expect(h.notes()).toHaveLength(3);
    expect(h.notes().filter((n) => n.pitch === 60).map((n) => n.start)).toEqual([0, GRID]);
  });

  it("still snaps: Alt is consumed as the duplicate modifier", () => {
    const h = createHarness();
    h.drag([12, h.yMid(60)], [12 + PX_PER_GRID + 4, h.yMid(60)], { alt: true });
    const copies = h.notes().filter((n) => n.pitch === 60).map((n) => n.start);
    expect(copies).toEqual([0, GRID]);
  });

  it("Alt+vertical drag adjusts velocity instead (SS10 hit-zone list)", () => {
    const h = createHarness();
    h.down(12, h.yMid(60), { alt: true });
    h.move(12, h.yMid(60) - 20, { alt: true });
    const preview = h.engine.preview as DupPreview;
    expect(preview.mode).toBe("velocity");
    // 20 px up over the 160 px full-scale range = +16 velocity steps.
    expect(preview.velocities).toEqual([{ id: "n1", vel: 116 }]);
    h.up(12, h.yMid(60) - 20, { alt: true });
    expect(h.labels()).toEqual(["Set Velocity"]);
    expect(h.note("n1")?.vel).toBe(116);
    expect(h.notes()).toHaveLength(2); // nothing was duplicated
  });

  it("locks the mode for the rest of the gesture", () => {
    const h = createHarness();
    h.down(12, h.yMid(60), { alt: true });
    h.move(12, h.yMid(60) - 40, { alt: true }); // vertical first
    h.move(12 + 80, h.yMid(60) - 40, { alt: true }); // then horizontal
    expect((h.engine.preview as DupPreview).mode).toBe("velocity");
  });

  it("Esc reverts", () => {
    const h = createHarness();
    h.down(12, h.yMid(60), { alt: true });
    h.move(12 + PX_PER_GRID, h.yMid(60), { alt: true });
    h.esc();
    expect(h.dispatched).toHaveLength(0);
    expect(h.notes()).toHaveLength(2);
  });
});

describe("Marquee", () => {
  it("selects live while dragging and commits no command", () => {
    const h = createHarness();
    h.down(400, h.yMid(66));
    h.move(200, h.yMid(66));
    expect(h.selectionIds()).toEqual([]);
    h.move(2, h.yMid(58));
    const preview = h.engine.preview as MarqueePreview;
    expect(preview.kind).toBe("marquee");
    expect(new Set(preview.hits)).toEqual(new Set(["n1", "n2"]));
    expect(new Set(h.selectionIds())).toEqual(new Set(["n1", "n2"]));

    h.up(2, h.yMid(58));
    expect(h.dispatched).toHaveLength(0);
    expect(new Set(h.selectionIds())).toEqual(new Set(["n1", "n2"]));
  });

  it("shrinks the selection again when the rectangle shrinks", () => {
    const h = createHarness();
    h.down(400, h.yMid(66));
    h.move(2, h.yMid(58));
    expect(h.selectionIds()).toHaveLength(2);
    h.move(40, h.yMid(58));
    expect(h.selectionIds()).toEqual(["n2"]);
  });

  it("Shift keeps the base selection", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.up(12, h.yMid(60));
    h.down(400, h.yMid(66), { shift: true });
    h.move(h.x(960) - 2, h.yMid(63), { shift: true });
    h.up(h.x(960) - 2, h.yMid(63), { shift: true });
    expect(new Set(h.selectionIds())).toEqual(new Set(["n1", "n2"]));
  });

  it("Esc restores the selection the drag started from", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.up(12, h.yMid(60));
    expect(h.selectionIds()).toEqual(["n1"]);

    h.down(400, h.yMid(66));
    h.move(2, h.yMid(58));
    expect(h.selectionIds()).toHaveLength(2);
    h.esc();
    expect(h.selectionIds()).toEqual(["n1"]);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("DragVel", () => {
  it("sets the velocity of the stalk under the pointer", () => {
    const h = createHarness();
    h.down(h.x(960), h.velY(40));
    expect(h.engine.phase).toBe("dragging"); // threshold 0: the press IS the edit
    const preview = h.engine.preview as VelocityPreview;
    expect(preview.vel).toBe(40);
    expect(preview.edits).toEqual([{ id: "n2", vel: 40 }]);
    expect(h.note("n2")?.vel).toBe(100); // still no document traffic

    h.up(h.x(960), h.velY(40));
    expect(h.labels()).toEqual(["Set Velocity"]);
    expect(h.note("n2")?.vel).toBe(40);
    expect(h.note("n1")?.vel).toBe(100);
  });

  it("sets every stalk in the swept x-range", () => {
    const h = createHarness();
    h.down(h.x(960), h.velY(30));
    h.move(0, h.velY(30));
    h.up(0, h.velY(30));
    expect(h.note("n1")?.vel).toBe(30);
    expect(h.note("n2")?.vel).toBe(30);
    expect(h.labels()).toEqual(["Set Velocity"]);
  });

  it("edits from empty lane space too, and commits nothing when unchanged", () => {
    const h = createHarness();
    h.down(h.x(400), h.velY(100));
    h.up(h.x(400), h.velY(100));
    expect(h.dispatched).toHaveLength(0);
  });

  it("Esc reverts", () => {
    const h = createHarness();
    h.down(h.x(960), h.velY(20));
    h.esc();
    expect(h.dispatched).toHaveLength(0);
    expect(h.note("n2")?.vel).toBe(100);
  });
});

describe("Paint (pencil)", () => {
  it("creates a grid-length note on press and extends it to the right", () => {
    const h = createHarness({ tool: "pencil" });
    h.down(h.x(2000), h.yMid(66));
    const preview = h.engine.preview as PaintPreview;
    expect(preview.ghost).toMatchObject({ start: 1920, dur: GRID, pitch: 66 });
    expect(h.audition.ons()).toEqual([66]);
    expect(h.notes()).toHaveLength(2);

    h.move(h.x(2700), h.yMid(66));
    expect((h.engine.preview as PaintPreview).ghost.dur).toBe(2880 - 1920);

    h.up(h.x(2700), h.yMid(66));
    expect(h.labels()).toEqual(["Add Note"]);
    expect(h.notes().find((n) => n.pitch === 66)).toMatchObject({ start: 1920, dur: 960 });
    expect(h.audition.offs()).toEqual([66]);
  });

  it("keeps one stroke to one note however far the pointer wanders", () => {
    const h = createHarness({ tool: "pencil" });
    h.down(h.x(2000), h.yMid(66));
    h.move(h.x(2400), h.yMid(70));
    h.up(h.x(2400), h.yMid(70));
    expect(h.notes()).toHaveLength(3);
    expect(h.notes().filter((n) => n.pitch === 70)).toHaveLength(0);
  });

  it("Esc reverts: no note is created", () => {
    const h = createHarness({ tool: "pencil" });
    h.down(h.x(2000), h.yMid(66));
    h.move(h.x(2400), h.yMid(66));
    h.esc();
    expect(h.dispatched).toHaveLength(0);
    expect(h.notes()).toHaveLength(2);
    expect(h.audition.offs()).toEqual([66]);
  });

  it("still moves existing notes in pencil mode", () => {
    const h = createHarness({ tool: "pencil" });
    h.drag([12, h.yMid(60)], [12 + PX_PER_GRID, h.yMid(60)]);
    expect(h.labels()).toEqual(["Move Notes"]);
  });
});

describe("ruler scrub", () => {
  it("seeks on press and while dragging, and dispatches nothing", () => {
    const seeks: number[] = [];
    const h = createHarness({ onSeek: (tick) => seeks.push(tick) });
    h.down(h.x(1000), h.rulerY());
    h.move(h.x(2000), h.rulerY());
    h.up(h.x(2000), h.rulerY());
    expect(seeks).toEqual([960, 1920]);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("one gesture, one command, one undo entry (SS13)", () => {
  it("never dispatches while the pointer moves", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    for (let i = 1; i <= 20; i += 1) h.move(12 + i * 3, h.yMid(60) - i);
    expect(h.dispatched).toHaveLength(0);
    h.up(12 + 60, h.yMid(60) - 20);
    expect(h.dispatched).toHaveLength(1);
  });

  it("undo restores exactly what one gesture changed", () => {
    const h = createHarness();
    h.drag([12, h.yMid(60)], [12 + PX_PER_GRID, h.yMid(60) - 16]);
    expect(h.store.history()).toHaveLength(1);
    expect(h.store.undoLabel()).toBe("Move Notes");
    expect(h.note("n1")).toMatchObject({ start: GRID, pitch: 61 });

    h.store.undo();
    expect(h.note("n1")).toMatchObject({ start: 0, pitch: 60 });
    h.store.redo();
    expect(h.note("n1")).toMatchObject({ start: GRID, pitch: 61 });
  });

  it("an aborted gesture pushes no history at all", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(12 + PX_PER_GRID, h.yMid(60));
    h.esc();
    expect(h.store.history()).toHaveLength(0);
    expect(h.store.canUndo()).toBe(false);
  });
});
