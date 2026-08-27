// SS10 "Snapping" — adaptive/fixed/triplet division, and the rule that makes
// off-grid material survive editing: MOVES SNAP THE DELTA, creation snaps the
// position, `Alt` bypasses both.

import { describe, expect, it, vi } from "vitest";
import { PPQ, TICKS_PER_WHOLE_NOTE } from "../../types";
import { ADAPTIVE_MIN_GRID_PX, DEFAULT_GRID_SETTINGS, createGrid } from "./grid";
import { snapBypassed, snapCreateTick, snapMoveDelta } from "./snapping";
import { modifiers } from "./points";
import { createViewport } from "./viewport";

const BAR = TICKS_PER_WHOLE_NOTE;

function setup(pxPerTick = 0.05, settings?: Parameters<typeof createGrid>[0]["settings"]) {
  const viewport = createViewport({ pxPerTick, widthPx: 1000, heightPx: 400 });
  const grid = createGrid({ viewport, settings });
  return { viewport, grid };
}

describe("grid — settings", () => {
  it("defaults to adaptive, straight, 1/16 fallback denominator", () => {
    const { grid } = setup();
    expect(grid.settings).toEqual(DEFAULT_GRID_SETTINGS);
    expect(DEFAULT_GRID_SETTINGS.mode).toBe("adaptive");
  });

  it("fixed mode uses the denominator regardless of zoom", () => {
    const { viewport, grid } = setup(0.05, { mode: "fixed", denominator: 16 });
    expect(grid.gridTicks()).toBe(240);
    viewport.zoomAt(0, 20);
    expect(grid.gridTicks()).toBe(240);
  });

  it("the triplet toggle gives 2/3 of the straight duration", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 8, triplet: true });
    expect(grid.gridTicks()).toBe(320);
    expect(grid.gridTicks() * 3).toBe(PPQ); // 3 in the space of a quarter
  });

  it("notifies on a real settings change only", () => {
    const { grid } = setup();
    const seen = vi.fn();
    grid.onChange(seen);
    grid.setSettings({ mode: "adaptive" });
    expect(seen).not.toHaveBeenCalled();
    grid.setSettings({ mode: "fixed", denominator: 8 });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("grid — adaptive division follows the zoom (SS10 'as in Live')", () => {
  it("never picks a division narrower than ADAPTIVE_MIN_GRID_PX on screen", () => {
    for (const pxPerTick of [0.001, 0.005, 0.02, 0.05, 0.2, 0.5, 1, 2]) {
      const { grid } = setup(pxPerTick);
      expect(grid.gridTicks() * pxPerTick).toBeGreaterThanOrEqual(ADAPTIVE_MIN_GRID_PX);
    }
  });

  it("gets finer as you zoom in and coarser as you zoom out", () => {
    const { viewport, grid } = setup(0.05);
    const mid = grid.gridTicks();
    viewport.zoomAt(0, 8);
    const zoomedIn = grid.gridTicks();
    viewport.zoomAt(0, 1 / 64);
    const zoomedOut = grid.gridTicks();
    expect(zoomedIn).toBeLessThan(mid);
    expect(zoomedOut).toBeGreaterThan(mid);
  });

  it("bottoms out at a 1/128 note (the SS10 resize floor)", () => {
    const { grid } = setup(2);
    expect(grid.gridTicks()).toBe(30);
  });

  it("stays on bar-scale divisions when fully zoomed out", () => {
    const { grid } = setup(0.0005);
    expect(grid.gridTicks() % BAR).toBe(0);
  });

  it("re-notifies when a zoom changes the adaptive division, not otherwise", () => {
    const { viewport, grid } = setup(0.05);
    const seen = vi.fn();
    grid.onChange(seen);
    viewport.scrollBy(100, 0);
    expect(seen).not.toHaveBeenCalled();
    viewport.zoomAt(0, 16);
    expect(seen).toHaveBeenCalled();
  });
});

describe("grid — snap vs snapDelta (SS10: moves are RELATIVE)", () => {
  it("snap is absolute: it lands on the grid", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 16 }); // 240
    expect(grid.snap(250)).toBe(240);
    expect(grid.snap(250, "ceil")).toBe(480);
    expect(grid.snap(250, "floor")).toBe(240);
  });

  it("snapDelta preserves an off-grid offset across a move", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 16 }); // 240
    const offGridStart = 137;
    const rawDelta = 250;
    const moved = offGridStart + grid.snapDelta(rawDelta);
    expect(grid.snapDelta(rawDelta)).toBe(240);
    expect(moved).toBe(377);
    expect(moved % 240).toBe(offGridStart % 240); // offset intact
  });

  it("absolute snapping would have destroyed that offset", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 16 });
    expect(grid.snap(137 + 250)).toBe(480);
    expect(grid.snap(137 + 250)).not.toBe(377);
  });

  it("mode 'off' disables snapping but still reports a usable division", () => {
    const { grid } = setup(0.05, { mode: "off" });
    expect(grid.snap(137)).toBe(137);
    expect(grid.snapDelta(137)).toBe(137);
    expect(grid.gridTicks()).toBeGreaterThan(0);
  });

  it("snapDelta rounds a negative delta symmetrically", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 16 });
    expect(grid.snapDelta(-250)).toBe(-240);
    expect(grid.snapDelta(-130)).toBe(-240);
    expect(grid.snapDelta(-100)).toBe(0);
  });
});

describe("snapping helpers — the `Alt` bypass, written once (SS10)", () => {
  it("Alt bypasses relative snapping mid-drag", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 16 });
    expect(snapMoveDelta(grid, 250, modifiers())).toBe(240);
    expect(snapMoveDelta(grid, 250, modifiers({ alt: true }))).toBe(250);
    expect(snapBypassed(modifiers({ alt: true }))).toBe(true);
  });

  it("Alt bypasses absolute snapping when creating", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 16 });
    expect(snapCreateTick(grid, 250, modifiers())).toBe(240);
    expect(snapCreateTick(grid, 250, modifiers({ alt: true }))).toBe(250);
  });

  it("creation floors by default, so a click creates AT the cell you clicked", () => {
    const { grid } = setup(0.05, { mode: "fixed", denominator: 16 });
    expect(snapCreateTick(grid, 470, modifiers())).toBe(240);
    expect(snapCreateTick(grid, 470, modifiers(), "nearest")).toBe(480);
  });
});
