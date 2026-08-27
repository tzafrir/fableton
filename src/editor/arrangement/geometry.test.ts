// SS10's hit zones, clip flavour: "Body — move. Left/right EDGE ZONES:
// min(6 px, 40% of note width) each side, so short notes always keep a
// grabbable body" — plus the loop brace band this editor adds on top.

import { describe, expect, it } from "vitest";
import { createViewport } from "../kit";
import type { ClipView } from "./geometry";
import {
  braceHeightPx,
  clipRect,
  clipSpanPx,
  edgeZonePx,
  laneRect,
  loopSpanTicks,
  spansOverlap,
  zoneAt,
} from "./geometry";
import { EDGE_ZONE_PX, LOOP_HANDLE_PX } from "./constants";

const BAR = 3840;

function viewport(pxPerTick = 0.05, pxPerRow = 40) {
  return createViewport({ pxPerTick, pxPerRow, widthPx: 1000, heightPx: 200 });
}

function clip(overrides: Partial<ClipView> = {}): ClipView {
  return {
    id: "c1",
    trackId: "t1",
    start: 0,
    length: BAR,
    notes: [],
    ...overrides,
  } as ClipView;
}

describe("edge zones (SS10)", () => {
  it("is 6 px on a wide clip and 40% of the width on a narrow one", () => {
    expect(edgeZonePx(192)).toBe(EDGE_ZONE_PX);
    expect(edgeZonePx(10)).toBeCloseTo(4);
  });

  it("always leaves a body: the two zones never cover the whole clip", () => {
    for (const width of [1, 3, 10, 15, 30, 192]) {
      expect(edgeZonePx(width) * 2).toBeLessThan(width + 1e-9);
    }
  });
});

describe("clip geometry", () => {
  it("maps ticks to pixels through the viewport only", () => {
    const vp = viewport();
    const span = clipSpanPx(vp, BAR, BAR);
    expect(span.x).toBeCloseTo(192);
    expect(span.w).toBeCloseTo(192);
  });

  it("insets the drawn rectangle inside its lane cell", () => {
    const vp = viewport();
    const lane = laneRect(vp, 1, 1000);
    const rect = clipRect(vp, 1, 0, BAR);
    expect(rect.y).toBeGreaterThan(lane.y);
    expect(rect.y + rect.h).toBeLessThan(lane.y + lane.h);
  });

  it("keeps a 1 px minimum width so a tiny clip stays clickable", () => {
    const vp = viewport(0.0005);
    expect(clipSpanPx(vp, 0, 60).w).toBe(1);
  });
});

describe("zoneAt", () => {
  const vp = viewport();

  it("resolves body, both edges and the outside", () => {
    const c = clip();
    expect(zoneAt(vp, c, 0, 100, 20)).toBe("body");
    expect(zoneAt(vp, c, 0, 2, 20)).toBe("edgeL");
    expect(zoneAt(vp, c, 0, 190, 20)).toBe("edgeR");
    expect(zoneAt(vp, c, 0, 300, 20)).toBeNull();
  });

  it("returns null when the pointer is on another row", () => {
    expect(zoneAt(vp, clip(), 0, 100, 60)).toBeNull();
  });

  it("puts the loop brace handles above the edge zones", () => {
    const c = clip({ loop: { start: 960, end: 2880 } });
    const braceY = 2;
    expect(zoneAt(vp, c, 0, vp.xOf(960), braceY)).toBe("loopStart");
    expect(zoneAt(vp, c, 0, vp.xOf(2880), braceY)).toBe("loopEnd");
    expect(zoneAt(vp, c, 0, vp.xOf(1920), braceY)).toBe("loopBody");
    // Below the brace band the same x is an ordinary body hit.
    expect(zoneAt(vp, c, 0, vp.xOf(1920), 30)).toBe("body");
  });

  it("grabs a handle within the tolerance and not beyond it", () => {
    const c = clip({ loop: { start: 960, end: 2880 } });
    const x = vp.xOf(960);
    expect(zoneAt(vp, c, 0, x + LOOP_HANDLE_PX - 1, 2)).toBe("loopStart");
    expect(zoneAt(vp, c, 0, x + LOOP_HANDLE_PX + 4, 2)).toBe("loopBody");
  });

  it("drops the brace on a squashed lane so the body stays grabbable", () => {
    const tiny = viewport(0.05, 12);
    expect(braceHeightPx(tiny)).toBe(0);
    const c = clip({ loop: { start: 960, end: 2880 } });
    expect(zoneAt(tiny, c, 0, tiny.xOf(1920), 1)).toBe("body");
  });
});

describe("loopSpanTicks", () => {
  it("converts clip-relative loop bounds to absolute song ticks", () => {
    expect(loopSpanTicks(clip({ start: BAR, loop: { start: 480, end: 1440 } }))).toEqual({
      start: BAR + 480,
      end: BAR + 1440,
    });
  });

  it("is null for an unlooped clip", () => {
    expect(loopSpanTicks(clip())).toBeNull();
  });
});

describe("spansOverlap", () => {
  it("is half-open and covers zero-length spans", () => {
    expect(spansOverlap(0, 10, 10, 20)).toBe(false);
    expect(spansOverlap(0, 10, 9, 20)).toBe(true);
    expect(spansOverlap(5, 5, 0, 10)).toBe(true);
    expect(spansOverlap(5, 5, 6, 10)).toBe(false);
  });
});
