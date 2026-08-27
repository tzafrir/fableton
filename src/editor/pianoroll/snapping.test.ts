// SS10 "Snapping", as the piano roll uses it:
//
//   "Grid is adaptive to zoom (as in Live) with a fixed-grid override menu and
//    a triplet toggle. Moves are RELATIVE ... absolute snap applies only when
//    creating. `Alt` while dragging bypasses snap entirely. Resize snaps the
//    moving edge, never the anchored one."

import { describe, expect, it } from "vitest";
import { createHarness } from "./testing/harness";

describe("adaptive grid", () => {
  it("coarsens as the editor zooms out", () => {
    const fine = createHarness({ pxPerTick: 0.05 });
    expect(fine.grid.gridTicks()).toBe(240); // 1/16 at 12 px

    const coarse = createHarness({ pxPerTick: 0.01 });
    expect(coarse.grid.gridTicks()).toBe(1920); // 1/2 note

    const surgical = createHarness({ pxPerTick: 0.5 });
    expect(surgical.grid.gridTicks()).toBe(30); // 1/128, the floor
  });

  it("drives the move delta at that zoom", () => {
    const h = createHarness({ pxPerTick: 0.01 });
    // n1 is only 4.8 px wide here, so 2.5 px is its body; 19 px = 1900 ticks,
    // which snaps to the 1920-tick division.
    h.drag([2.5, h.yMid(60)], [2.5 + 19, h.yMid(60)]);
    expect(h.note("n1")?.start).toBe(1920);
  });
});

describe("fixed override and the triplet toggle", () => {
  it("uses the chosen denominator", () => {
    const h = createHarness();
    h.grid.setSettings({ mode: "fixed", denominator: 4 });
    expect(h.grid.gridTicks()).toBe(960);
    h.drag([12, h.yMid(60)], [12 + 48, h.yMid(60)]);
    expect(h.note("n1")?.start).toBe(960);
  });

  it("triplets are two thirds of the straight division", () => {
    const h = createHarness();
    h.grid.setSettings({ mode: "fixed", denominator: 4, triplet: true });
    expect(h.grid.gridTicks()).toBe(640);
    h.drag([12, h.yMid(60)], [12 + 32, h.yMid(60)]);
    expect(h.note("n1")?.start).toBe(640);
  });

  it("mode 'off' stops snapping but still reports a division", () => {
    const h = createHarness();
    h.grid.setSettings({ mode: "off" });
    expect(h.grid.gridTicks()).toBeGreaterThan(0);
    h.drag([12, h.yMid(60)], [12 + 7, h.yMid(60)]);
    expect(h.note("n1")?.start).toBe(140); // 7 px = 140 ticks, verbatim
  });
});

describe("relative vs absolute", () => {
  it("a move preserves an off-grid offset; creation lands ON the grid", () => {
    const h = createHarness({ notes: [{ id: "off", start: 100, dur: 480, pitch: 60, vel: 100 }] });
    h.drag([h.x(100) + 12, h.yMid(60)], [h.x(100) + 24, h.yMid(60)]);
    expect(h.note("off")?.start).toBe(340);

    const x = h.x(2110);
    h.down(x, h.yMid(66), undefined, 2);
    h.up(x, h.yMid(66), undefined, 2);
    expect(h.notes().find((n) => n.pitch === 66)?.start).toBe(1920);
  });

  it("Alt bypasses snap on creation too", () => {
    const h = createHarness();
    const x = h.x(2110);
    h.down(x, h.yMid(66), { alt: true }, 2);
    h.up(x, h.yMid(66), { alt: true }, 2);
    expect(h.notes().find((n) => n.pitch === 66)?.start).toBe(h.viewport.tAt(x));
  });
});

describe("resize snaps the moving edge only", () => {
  it("keeps the anchored edge exactly where it was", () => {
    const h = createHarness({ notes: [{ id: "off", start: 100, dur: 480, pitch: 60, vel: 100 }] });
    const x = h.x(100);
    // Drag the LEFT edge 15 px right: the delta snaps to 240, the end stays.
    h.drag([x + 2, h.yMid(60)], [x + 17, h.yMid(60)]);
    const note = h.note("off");
    expect(note?.start).toBe(340);
    expect((note?.start ?? 0) + (note?.dur ?? 0)).toBe(580);
  });

  it("the right edge moves by a snapped delta from its own position", () => {
    const h = createHarness({ notes: [{ id: "off", start: 100, dur: 470, pitch: 60, vel: 100 }] });
    const right = h.x(570);
    h.drag([right - 2, h.yMid(60)], [right + 10, h.yMid(60)]);
    const note = h.note("off");
    expect(note?.start).toBe(100);
    expect(note?.dur).toBe(470 + 240);
  });

  it("Alt bypasses snap while resizing", () => {
    const h = createHarness();
    h.down(22, h.yMid(60));
    h.move(22 + 7, h.yMid(60), { alt: true });
    h.up(22 + 7, h.yMid(60), { alt: true });
    expect(h.note("n1")?.dur).toBe(480 + 140);
  });
});
