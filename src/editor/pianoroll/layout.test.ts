import { describe, expect, it } from "vitest";
import { EDGE_ZONE_FRACTION, EDGE_ZONE_PX } from "../../types/editor";
import { createViewport } from "../kit/viewport";
import {
  MAX_PITCH,
  MIN_PITCH,
  RULER_HEIGHT_PX,
  VELOCITY_LANE_HEIGHT_PX,
  clampPitch,
  clampVelocity,
  createPianoRollLayout,
  edgeZonePx,
  isInNoteArea,
  isInRuler,
  isInVelocityLane,
  noteRect,
  pitchAtY,
  pitchDeltaOfRows,
  pitchOfRow,
  rowAtY,
  rowOfPitch,
  velocityAtY,
  yOfPitch,
  yOfVelocity,
} from "./layout";

const viewport = (): ReturnType<typeof createViewport> => {
  const vp = createViewport({
    pxPerTick: 0.05,
    pxPerRow: 16,
    widthPx: 800,
    heightPx: 400,
    limits: { minRow: 0, maxRow: 128 },
  });
  vp.setScroll(0, rowOfPitch(72));
  return vp;
};

describe("row convention (SS9)", () => {
  it("maps pitch to row downward: row = 127 - pitch", () => {
    expect(rowOfPitch(MAX_PITCH)).toBe(0);
    expect(rowOfPitch(MIN_PITCH)).toBe(127);
    expect(pitchOfRow(0)).toBe(127);
    expect(pitchOfRow(127)).toBe(0);
    expect(pitchOfRow(66.9)).toBe(61);
  });

  it("turns a downward row drag into a downward transpose", () => {
    expect(pitchDeltaOfRows(1)).toBe(-1);
    expect(pitchDeltaOfRows(-2.4)).toBe(2);
    expect(pitchDeltaOfRows(0.4)).toBe(0);
  });
});

describe("the vertical stack", () => {
  it("puts the ruler on top and the velocity lane at the bottom", () => {
    const vp = viewport();
    const layout = createPianoRollLayout(vp);
    expect(layout.rulerHeightPx).toBe(RULER_HEIGHT_PX);
    expect(layout.velocityLaneHeightPx).toBe(VELOCITY_LANE_HEIGHT_PX);
    expect(layout.noteTopPx).toBe(RULER_HEIGHT_PX);
    expect(layout.noteBottomPx).toBe(400 - VELOCITY_LANE_HEIGHT_PX);
    expect(layout.velocityBottomPx).toBe(400);

    expect(isInRuler(layout, 5)).toBe(true);
    expect(isInNoteArea(layout, 200)).toBe(true);
    expect(isInVelocityLane(layout, 350)).toBe(true);
  });

  it("gives the note grid its floor when the editor is tiny", () => {
    const vp = viewport();
    vp.setSize(800, 50);
    const layout = createPianoRollLayout(vp);
    expect(layout.velocityLaneHeightPx).toBe(0);
    expect(layout.noteBottomPx).toBe(50);
  });

  it("tracks a resize without re-wiring", () => {
    const vp = viewport();
    const layout = createPianoRollLayout(vp);
    vp.setSize(800, 600);
    expect(layout.noteBottomPx).toBe(600 - VELOCITY_LANE_HEIGHT_PX);
  });
});

describe("pixel <-> pitch", () => {
  it("offsets the row axis by the ruler height", () => {
    const vp = viewport();
    const layout = createPianoRollLayout(vp);
    // Row 55 (pitch 72) sits at the top of the note grid.
    expect(rowAtY(vp, layout, layout.noteTopPx)).toBe(55);
    expect(yOfPitch(vp, layout, 72)).toBe(20);
    expect(yOfPitch(vp, layout, 60)).toBe(20 + 12 * 16);
    expect(pitchAtY(vp, layout, 20)).toBe(72);
    expect(pitchAtY(vp, layout, 35)).toBe(72);
    expect(pitchAtY(vp, layout, 36)).toBe(71);
  });

  it("clamps out-of-range pitches and velocities", () => {
    expect(clampPitch(-3)).toBe(0);
    expect(clampPitch(400)).toBe(127);
    expect(clampVelocity(0)).toBe(1);
    expect(clampVelocity(999)).toBe(127);
  });

  it("places a note rectangle from ticks and pitch", () => {
    const vp = viewport();
    const layout = createPianoRollLayout(vp);
    const rect = noteRect(vp, layout, { start: 960, dur: 480, pitch: 64 });
    expect(rect.x).toBeCloseTo(48);
    expect(rect.w).toBeCloseTo(24);
    expect(rect.y).toBe(yOfPitch(vp, layout, 64));
    expect(rect.h).toBe(16);
  });
});

describe("edge zones (SS10)", () => {
  it("is min(6 px, 40% of note width)", () => {
    expect(edgeZonePx(100)).toBe(EDGE_ZONE_PX);
    expect(edgeZonePx(EDGE_ZONE_PX / EDGE_ZONE_FRACTION)).toBe(EDGE_ZONE_PX);
    expect(edgeZonePx(10)).toBeCloseTo(4);
    expect(edgeZonePx(1.5)).toBeCloseTo(0.6);
  });

  it("always leaves a grabbable body", () => {
    for (const width of [1, 2, 5, 10, 15, 60]) {
      expect(2 * edgeZonePx(width)).toBeLessThanOrEqual(width * 0.8 + 1e-9);
    }
  });
});

describe("velocity lane", () => {
  it("maps the lane top to 127 and the bottom to 1", () => {
    const vp = viewport();
    const layout = createPianoRollLayout(vp);
    expect(velocityAtY(layout, layout.velocityBottomPx)).toBe(1);
    expect(velocityAtY(layout, layout.velocityTopPx + 4)).toBe(127);
    expect(velocityAtY(layout, -50)).toBe(127);
    expect(velocityAtY(layout, 10_000)).toBe(1);
  });

  it("round-trips a velocity through its stalk tip", () => {
    const vp = viewport();
    const layout = createPianoRollLayout(vp);
    for (const vel of [1, 40, 64, 100, 127]) {
      expect(velocityAtY(layout, yOfVelocity(layout, vel))).toBe(vel);
    }
  });
});
