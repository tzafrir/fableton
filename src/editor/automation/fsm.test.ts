// SS11's verbs over SS10's gesture FSM, driven by synthetic pointer sequences
// (SS15). Each test asserts what the PREVIEW showed where it matters, which
// ONE command was dispatched, and what the document ended up holding.
//
// The harness's lane is 0..100 over 200 px at 0.05 px/tick: `h.x(tick)` and
// `h.y(value)` are the only coordinate arithmetic below.

import { describe, expect, it } from "vitest";
import type { MovePreview } from "./handlers";
import { createAutomationHarness, ENUM_DESC } from "./testing/harness";

const GRID = 240; // 1/16 note at the harness's zoom
const PX_PER_GRID = GRID * 0.05; // 12 px

describe("selection", () => {
  it("clicks select, Shift adds, and a click on empty clears", () => {
    const h = createAutomationHarness();
    h.click(h.x(0), h.y(0));
    expect(h.selected()).toEqual([0]);

    h.click(h.x(960), h.y(100), { shift: true });
    expect(h.selected()).toEqual([0, 960]);

    h.click(h.x(480), h.y(95));
    expect(h.selected()).toEqual([]);
    expect(h.dispatched).toHaveLength(0); // selection is never a document edit
  });

  it("marquee selects the points inside the rectangle", () => {
    const h = createAutomationHarness({
      points: [
        [240, 0],
        [720, 100],
        [1920, 50],
      ],
    });
    h.drag([2, 199], [60, 2]);
    expect(h.selected()).toEqual([240, 720]);
    expect(h.dispatched).toHaveLength(0); // SS10: marquee commits nothing
  });

  it("Delete removes the selection in one command", () => {
    const h = createAutomationHarness();
    h.click(h.x(960), h.y(100));
    h.key("Delete");
    expect(h.ticks()).toEqual([0, 1920]);
    expect(h.labels()).toEqual(["Delete Automation Points"]);
    expect(h.selected()).toEqual([]);
  });

  it("double-clicking a point deletes it", () => {
    const h = createAutomationHarness();
    h.click(h.x(960), h.y(100), undefined, 2);
    expect(h.ticks()).toEqual([0, 1920]);
    expect(h.labels()).toEqual(["Delete Automation Points"]);
  });
});

describe("adding points", () => {
  it("SS11 'click a segment to add a point' — at the snapped tick", () => {
    const h = createAutomationHarness();
    h.click(h.x(480), h.y(50));
    expect(h.ticks()).toEqual([0, 480, 960, 1920]);
    expect(h.labels()).toEqual(["Add Automation Point"]);
    expect(h.selected()).toEqual([480]);
  });

  // The lane draws a flat line past its first and last points, so SS11's
  // "click a segment to add a point" has to work there too — it is a drawn
  // curve, even though it is no bendable segment (hits.ts `flat`). This is
  // what a single click on the line the e2e sees "span the lane" does.
  it("SS11 'click a segment to add a point' — on the flat lead-in and trail-out", () => {
    const h = createAutomationHarness({ points: [[960, 100]] });
    h.click(h.x(480), h.y(100));
    expect(h.ticks()).toEqual([480, 960]);
    expect(h.labels()).toEqual(["Add Automation Point"]);

    h.click(h.x(1920), h.y(100));
    expect(h.ticks()).toEqual([480, 960, 1920]);
    expect(h.selected()).toEqual([1920]);
  });

  it("a click OFF the flat line still just clears the selection", () => {
    const h = createAutomationHarness({ points: [[960, 100]] });
    h.click(h.x(960), h.y(100)); // select the point
    expect(h.selected()).toEqual([960]);
    h.click(h.x(480), h.y(20)); // nowhere near the drawn line
    expect(h.ticks()).toEqual([960]);
    expect(h.selected()).toEqual([]);
    expect(h.labels()).toEqual([]);
  });

  it("double-click on empty space adds a point there", () => {
    const h = createAutomationHarness({ points: [] });
    h.click(h.x(960), h.y(25), undefined, 2);
    expect(h.ticks()).toEqual([960]);
    expect(h.values()[0]).toBeCloseTo(25);

    h.click(h.x(1920), h.y(75), undefined, 2);
    expect(h.ticks()).toEqual([960, 1920]);
  });
});

describe("moving points", () => {
  it("drags one point on both axes and commits one command", () => {
    const h = createAutomationHarness();
    h.drag([h.x(960), h.y(100)], [h.x(960) + PX_PER_GRID, h.y(50)]);
    expect(h.ticks()).toEqual([0, 1200, 1920]);
    expect(h.values()[1]).toBeCloseTo(50);
    expect(h.labels()).toEqual(["Move Automation Points"]);
    expect(h.selected()).toEqual([1200]);
  });

  it("moves the whole selection relative to itself", () => {
    const h = createAutomationHarness({
      points: [
        [240, 0],
        [720, 100],
      ],
    });
    h.click(h.x(240), h.y(0));
    h.click(h.x(720), h.y(100), { shift: true });
    h.drag([h.x(240), h.y(0)], [h.x(240) + PX_PER_GRID, h.y(0)]);
    expect(h.ticks()).toEqual([480, 960]);
  });

  // The bug this file exists for: clamping each point at tick 0 independently
  // piles the whole selection onto tick 0, and a lane holds ONE point per
  // tick — every point but the last would be destroyed. SS10: moves are
  // relative, so the DELTA is what clamps.
  it("clamps a leftward group move as a group, keeping every point", () => {
    const h = createAutomationHarness({
      points: [
        [240, 0],
        [720, 100],
      ],
    });
    h.click(h.x(240), h.y(0));
    h.click(h.x(720), h.y(100), { shift: true });
    // Two grid steps left, from a point that can only give one.
    h.drag([h.x(240), h.y(0)], [h.x(240) - 2 * PX_PER_GRID, h.y(0)]);
    expect(h.ticks()).toEqual([0, 480]);
    expect(h.values()[0]).toBeCloseTo(0);
    expect(h.values()[1]).toBeCloseTo(100);
  });

  it("shows the clamped delta in the preview, not just in the commit", () => {
    const h = createAutomationHarness({
      points: [
        [240, 0],
        [720, 100],
      ],
    });
    h.click(h.x(240), h.y(0));
    h.click(h.x(720), h.y(100), { shift: true });
    h.down(h.x(240), h.y(0));
    h.move(h.x(240) - 4 * PX_PER_GRID, h.y(0));
    const preview = h.engine.preview as MovePreview;
    expect(preview.ghosts.map((g) => g.toT)).toEqual([0, 480]);
    h.esc();
    expect(h.dispatched).toHaveLength(0); // Esc: zero document traffic
    expect(h.ticks()).toEqual([240, 720]);
  });

  it("Alt bypasses the snap (SS10)", () => {
    const h = createAutomationHarness();
    h.drag([h.x(0), h.y(0)], [h.x(0) + 5, h.y(0)], { alt: true });
    expect(h.ticks()[0]).toBe(h.viewport.tickDeltaOf(5));
  });
});

describe("keyboard nudges", () => {
  const twoPoints: [number, number][] = [
    [240, 0],
    [720, 100],
  ];

  it("ArrowLeft/Right move the selection by one grid step", () => {
    const h = createAutomationHarness({ points: [...twoPoints] });
    h.click(h.x(240), h.y(0));
    h.key("ArrowRight");
    expect(h.ticks()).toEqual([480, 720]);
    h.key("ArrowLeft");
    expect(h.ticks()).toEqual([240, 720]);
  });

  it("clamps the nudge as a group, and refuses the one that would do nothing", () => {
    const h = createAutomationHarness({ points: [...twoPoints] });
    h.click(h.x(240), h.y(0));
    h.click(h.x(720), h.y(100), { shift: true });

    h.key("ArrowLeft");
    expect(h.ticks()).toEqual([0, 480]); // one step, not two collapsed into one
    expect(h.selected()).toEqual([0, 480]);

    // Against the wall now: nothing moves, and nothing lands in the undo
    // stack. (Clamping per point instead would have merged both onto 0.)
    h.key("ArrowLeft");
    expect(h.ticks()).toEqual([0, 480]);
    expect(h.labels()).toEqual(["Move Automation Points"]);
  });

  it("ArrowUp/Down move the value, Shift makes the step fine", () => {
    const h = createAutomationHarness({ points: [[960, 50]] });
    h.click(h.x(960), h.y(50));
    h.key("ArrowUp");
    const coarse = h.values()[0] as number;
    expect(coarse).toBeGreaterThan(50);
    h.key("ArrowDown");
    expect(h.values()[0]).toBeCloseTo(50);
    h.key("ArrowUp", { shift: true });
    expect((h.values()[0] as number) - 50).toBeLessThan(coarse - 50);
  });
});

describe("bending a segment", () => {
  it("stores the drag as the segment's curve", () => {
    const h = createAutomationHarness();
    // 30 px down over a 120 px full sweep = +0.5 (down = ease-in).
    h.drag([h.x(480), h.y(50)], [h.x(480), h.y(50) + 30]);
    expect(h.points()[0]?.curve).toBeCloseTo(0.5);
    expect(h.labels()).toEqual(["Bend Automation Segment"]);
  });

  it("Esc leaves the curve alone", () => {
    const h = createAutomationHarness();
    h.down(h.x(480), h.y(50));
    h.move(h.x(480), h.y(50) + 30);
    h.esc();
    expect(h.points()[0]?.curve).toBe(0);
    expect(h.dispatched).toHaveLength(0);
  });

  // A discrete lane is a staircase: `curve` changes nothing about how it is
  // drawn, sampled or heard, so the drag must not store an invisible bend.
  it("does nothing on a discrete lane, but still adds a point on click", () => {
    const h = createAutomationHarness({
      desc: ENUM_DESC,
      points: [
        [0, 0],
        [1920, 3],
      ],
    });
    h.drag([h.x(960), h.y(0)], [h.x(960), h.y(0) - 40]);
    expect(h.points()[0]?.curve).toBe(0);
    expect(h.dispatched).toHaveLength(0);

    h.click(h.x(960), h.y(0));
    expect(h.ticks()).toEqual([0, 960, 1920]);
    expect(h.labels()).toEqual(["Add Automation Point"]);
  });
});
