import { describe, expect, it, vi } from "vitest";
import { PPQ, TICKS_PER_WHOLE_NOTE } from "../../types";
import {
  DEFAULT_PX_PER_ROW,
  DEFAULT_PX_PER_TICK,
  DEFAULT_VIEWPORT_LIMITS,
  createViewport,
} from "./viewport";

const BAR = TICKS_PER_WHOLE_NOTE; // 3840 ticks = one 4/4 bar

function vp(overrides: Parameters<typeof createViewport>[0] = {}) {
  return createViewport({
    pxPerTick: 0.05,
    pxPerRow: 16,
    widthPx: 1000,
    heightPx: 400,
    ...overrides,
  });
}

describe("viewport — the transform (SS9 coordinate discipline)", () => {
  it("defaults to an editable zoom and the frozen row height", () => {
    const v = createViewport();
    expect(v.pxPerTick).toBe(DEFAULT_PX_PER_TICK);
    expect(v.pxPerRow).toBe(DEFAULT_PX_PER_ROW);
    expect(v.scrollTicks).toBe(0);
    expect(v.scrollRows).toBe(0);
  });

  it("xOf/tAt round-trip through the origin and the scroll offset", () => {
    const v = vp({ scrollTicks: BAR });
    expect(v.xOf(BAR)).toBe(0);
    expect(v.tAt(0)).toBe(BAR);
    expect(v.xOf(BAR + PPQ)).toBeCloseTo(PPQ * 0.05, 10);
    expect(v.tAt(PPQ * 0.05)).toBe(BAR + PPQ);
  });

  it("tAt returns an INTEGER tick (SS8: fractional ticks are a bug)", () => {
    const v = vp({ pxPerTick: 0.037 });
    for (let x = -50; x <= 50; x += 1) {
      expect(Number.isInteger(v.tAt(x))).toBe(true);
    }
  });

  it("never hands back -0 from tAt or tickDeltaOf", () => {
    const v = vp();
    expect(Object.is(v.tAt(-0.4), -0)).toBe(false);
    expect(Object.is(v.tickDeltaOf(-0.4), -0)).toBe(false);
  });

  it("rowAt is fractional and rowIndexOf is its floor (rows go DOWN)", () => {
    const v = vp({ pxPerRow: 16, scrollRows: 0 });
    expect(v.rowAt(0)).toBe(0);
    expect(v.rowAt(8)).toBe(0.5);
    expect(v.rowAt(24)).toBe(1.5);
    expect(v.rowIndexOf(24)).toBe(1);
    // Larger y = larger row = further down. Piano roll: row = 127 - pitch.
    expect(v.yOf(0)).toBeLessThan(v.yOf(1));
  });

  it("rowIndexOf floors correctly above the viewport origin (negative y)", () => {
    const v = vp({ pxPerRow: 16, scrollRows: 4 });
    expect(v.rowIndexOf(-1)).toBe(3);
    expect(v.rowIndexOf(-16)).toBe(3);
    expect(v.rowIndexOf(-17)).toBe(2);
  });
});

describe("viewport — drag arithmetic", () => {
  it("tickDeltaOf rounds ONCE on the total delta", () => {
    const v = vp({ pxPerTick: 0.05 }); // 1 px = 20 ticks
    expect(v.tickDeltaOf(10)).toBe(200);
    expect(v.tickDeltaOf(-10)).toBe(-200);
    // Accumulating per-frame rounding would drift; one rounding does not.
    const total = v.tickDeltaOf(100);
    let perFrame = 0;
    for (let i = 0; i < 100; i += 1) perFrame += v.tickDeltaOf(1);
    expect(total).toBe(2000);
    expect(perFrame).toBe(2000);
  });

  it("tickDeltaOf is exact where per-frame accumulation would drift", () => {
    // 1 px = 1.6 ticks: per-frame rounding gives 2 ticks/px = 200 over 100 px.
    const v = vp({ pxPerTick: 0.625 });
    expect(v.tickDeltaOf(100)).toBe(160);
    let perFrame = 0;
    for (let i = 0; i < 100; i += 1) perFrame += v.tickDeltaOf(1);
    expect(perFrame).toBe(200);
    expect(v.tickDeltaOf(100)).not.toBe(perFrame);
  });

  it("rowDeltaOf stays fractional (the editor decides how to round pitch)", () => {
    const v = vp({ pxPerRow: 16 });
    expect(v.rowDeltaOf(24)).toBe(1.5);
    expect(v.rowDeltaOf(-8)).toBe(-0.5);
  });
});

describe("viewport — zoomAt keeps the time under the cursor fixed (SS9)", () => {
  it("holds the anchor tick within a tick of the cursor, zooming in", () => {
    const v = vp({ scrollTicks: 4 * BAR });
    const px = 372;
    const anchor = v.tAt(px);
    v.zoomAt(px, 2);
    expect(v.pxPerTick).toBeCloseTo(0.1, 10);
    // Exact to within the integer-scroll rounding: half a tick.
    expect(Math.abs(v.xOf(anchor) - px)).toBeLessThanOrEqual(v.pxPerTick);
  });

  it("holds the anchor tick zooming out, at every cursor position", () => {
    for (const px of [0, 1, 250, 999]) {
      const v = vp({ scrollTicks: 400 * BAR });
      const anchor = v.tAt(px);
      v.zoomAt(px, 0.5);
      expect(Math.abs(v.xOf(anchor) - px)).toBeLessThanOrEqual(v.pxPerTick);
    }
  });

  it("gives up the anchor rather than scrolling past minTick", () => {
    // Zooming out at the right edge of a viewport parked at tick 0 would need
    // a negative scroll; the clamp wins and the anchor slides right. That is
    // the correct trade — the transform stays inside its limits.
    const v = vp({ scrollTicks: 0 });
    v.zoomAt(999, 0.5);
    expect(v.scrollTicks).toBe(0);
    expect(v.pxPerTick).toBeCloseTo(0.025, 10);
  });

  it("survives a long zoom-in/zoom-out round trip without drifting away", () => {
    const v = vp({ scrollTicks: 8 * BAR });
    const px = 500;
    const anchor = v.tAt(px);
    for (let i = 0; i < 20; i += 1) v.zoomAt(px, 1.1);
    for (let i = 0; i < 20; i += 1) v.zoomAt(px, 1 / 1.1);
    expect(v.pxPerTick).toBeCloseTo(0.05, 6);
    expect(Math.abs(v.xOf(anchor) - px)).toBeLessThan(2);
  });

  it("clamps zoom to the limits and stops notifying once pinned", () => {
    const v = vp({ limits: { minPxPerTick: 0.01, maxPxPerTick: 0.2 } });
    const seen = vi.fn();
    v.onChange(seen);
    for (let i = 0; i < 50; i += 1) v.zoomAt(100, 2);
    expect(v.pxPerTick).toBe(0.2);
    const callsAtCeiling = seen.mock.calls.length;
    v.zoomAt(100, 2);
    expect(seen.mock.calls.length).toBe(callsAtCeiling);
  });

  it("zoomRowsAt keeps the row under the cursor fixed exactly", () => {
    const v = vp({ pxPerRow: 16, scrollRows: 3 });
    const py = 137;
    const anchor = v.rowAt(py);
    v.zoomRowsAt(py, 1.75);
    expect(v.pxPerRow).toBe(28);
    // scrollRows is fractional, so this one is exact.
    expect(v.yOf(anchor)).toBeCloseTo(py, 10);
  });

  it("ignores a non-positive or non-finite zoom factor", () => {
    const v = vp();
    v.zoomAt(100, 0);
    v.zoomAt(100, -2);
    v.zoomAt(100, Number.NaN);
    expect(v.pxPerTick).toBe(0.05);
  });
});

describe("viewport — scrolling and clamping", () => {
  it("scrollBy converts pixels to content units on both axes", () => {
    const v = vp({ scrollTicks: 10 * BAR, scrollRows: 10 });
    v.scrollBy(50, 32); // 50 px = 1000 ticks; 32 px = 2 rows
    expect(v.scrollTicks).toBe(10 * BAR + 1000);
    expect(v.scrollRows).toBe(12);
  });

  it("clamps scroll into the limits", () => {
    const v = vp({ limits: { minTick: 0, maxTick: 100 * BAR, minRow: 0, maxRow: 127 } });
    v.setScroll(-10_000, -5);
    expect(v.scrollTicks).toBe(0);
    expect(v.scrollRows).toBe(0);
    v.setScroll(10_000 * BAR, 900);
    expect(v.scrollTicks).toBe(100 * BAR);
    expect(v.scrollRows).toBe(127);
  });

  it("keeps scrollTicks an integer under fractional pixel scrolling", () => {
    const v = vp({ pxPerTick: 2 }); // 1 px = 0.5 ticks
    v.scrollBy(1, 0);
    expect(Number.isInteger(v.scrollTicks)).toBe(true);
  });

  it("re-clamps the current transform when limits shrink", () => {
    const v = vp({ scrollTicks: 50 * BAR, pxPerTick: 0.05 });
    v.setLimits({ maxTick: 4 * BAR, maxPxPerTick: 0.02 });
    expect(v.scrollTicks).toBe(4 * BAR);
    expect(v.pxPerTick).toBe(0.02);
  });

  it("default limits leave room for a long arrangement", () => {
    expect(DEFAULT_VIEWPORT_LIMITS.maxTick).toBeGreaterThanOrEqual(1000 * BAR);
    expect(DEFAULT_VIEWPORT_LIMITS.minRow).toBe(0);
  });
});

describe("viewport — reveal", () => {
  it("scrolls the minimum distance to bring a tick into view on the right", () => {
    const v = vp({ scrollTicks: 0, widthPx: 1000 }); // window is 20000 ticks
    v.revealTick(25_000);
    expect(v.xOf(25_000)).toBeCloseTo(1000, 6);
  });

  it("scrolls left with a margin and does nothing when already visible", () => {
    const v = vp({ scrollTicks: 20_000, widthPx: 1000 });
    v.revealTick(19_000, 40);
    expect(v.xOf(19_000)).toBeCloseTo(40, 0);
    const before = v.scrollTicks;
    v.revealTick(19_500);
    expect(v.scrollTicks).toBe(before);
  });

  it("revealRow accounts for the full height of the row cell", () => {
    const v = vp({ pxPerRow: 16, heightPx: 160, scrollRows: 0 }); // 10 rows
    v.revealRow(12);
    // Row 12 occupies [12,13): its BOTTOM must land on the viewport bottom.
    expect(v.yOf(13)).toBeCloseTo(160, 6);
    v.revealRow(0);
    expect(v.yOf(0)).toBeCloseTo(0, 6);
  });
});

describe("viewport — culling windows and notifications", () => {
  it("visibleTicks covers the whole fractional window with integer bounds", () => {
    const v = vp({ pxPerTick: 0.05, scrollTicks: 1234, widthPx: 1000 });
    const range = v.visibleTicks();
    expect(Number.isInteger(range.start)).toBe(true);
    expect(Number.isInteger(range.end)).toBe(true);
    expect(range.start).toBeLessThanOrEqual(1234);
    expect(range.end).toBeGreaterThanOrEqual(1234 + 20_000);
  });

  it("visibleRows pads by one row on each side", () => {
    const v = vp({ pxPerRow: 16, heightPx: 160, scrollRows: 5 });
    const rows = v.visibleRows();
    expect(rows.start).toBe(4);
    expect(rows.end).toBe(16);
  });

  it("fires onChange at most once per mutator, and only when something moved", () => {
    const v = vp();
    const seen = vi.fn();
    const unsub = v.onChange(seen);
    v.setScroll(v.scrollTicks, v.scrollRows);
    expect(seen).not.toHaveBeenCalled();
    v.setScroll(960, 2);
    expect(seen).toHaveBeenCalledTimes(1);
    v.zoomAt(100, 1.5);
    expect(seen).toHaveBeenCalledTimes(2);
    v.setSize(v.widthPx, v.heightPx);
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
    v.setScroll(0, 0);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("passes itself to subscribers so a layer can read the new transform", () => {
    const v = vp();
    let seenPxPerTick = 0;
    v.onChange((next) => {
      seenPxPerTick = next.pxPerTick;
    });
    v.zoomAt(0, 2);
    expect(seenPxPerTick).toBe(v.pxPerTick);
  });
});
