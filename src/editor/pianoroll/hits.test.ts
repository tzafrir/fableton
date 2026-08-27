// SS10 "Hit zones": the whole table, asserted against pure geometry.

import { describe, expect, it } from "vitest";
import { CURSORS, hitTestPianoRoll, isNoteHit, zoneOfNoteX } from "./hits";
import { createHarness } from "./testing/harness";
import { editorPointOf } from "../kit/points";

function hitAt(h: ReturnType<typeof createHarness>, x: number, y: number) {
  return hitTestPianoRoll(h.ctx, editorPointOf(h.viewport, x, y));
}

describe("zones", () => {
  it("resolves the ruler, the note grid and the velocity lane", () => {
    const h = createHarness();
    expect(hitAt(h, 100, h.rulerY())?.kind).toBe("ruler");
    expect(hitAt(h, 300, h.yMid(60))?.kind).toBe("grid");
    expect(hitAt(h, 300, h.velY(64))?.kind).toBe("velocity-lane");
  });

  it("hits a note body and reports the move cursor", () => {
    const h = createHarness();
    const hit = hitAt(h, 12, h.yMid(60));
    expect(hit?.kind).toBe("note-body");
    expect(hit?.cursor).toBe(CURSORS.body);
    expect(hit !== null && isNoteHit(hit) ? hit.noteId : null).toBe("n1");
  });

  it("hits the left and right edge zones", () => {
    const h = createHarness();
    // n1 spans x 0..24, so the edge zone is min(6, 40% * 24) = 6 px.
    expect(hitAt(h, 2, h.yMid(60))?.kind).toBe("note-edge-l");
    expect(hitAt(h, 6, h.yMid(60))?.kind).toBe("note-edge-l");
    expect(hitAt(h, 7, h.yMid(60))?.kind).toBe("note-body");
    expect(hitAt(h, 17, h.yMid(60))?.kind).toBe("note-body");
    expect(hitAt(h, 18, h.yMid(60))?.kind).toBe("note-edge-r");
    expect(hitAt(h, 24, h.yMid(60))?.kind).toBe("note-edge-r");
    expect(hitAt(h, 30, h.yMid(60))?.kind).toBe("grid");
  });

  it("keeps a body on a very short note (40% rule)", () => {
    // 120 ticks = 6 px wide: edges are 2.4 px each, body is 1.2 px.
    const h = createHarness({ notes: [{ id: "s1", start: 0, dur: 120, pitch: 60, vel: 100 }] });
    expect(hitAt(h, 1, h.yMid(60))?.kind).toBe("note-edge-l");
    expect(hitAt(h, 3, h.yMid(60))?.kind).toBe("note-body");
    expect(hitAt(h, 5, h.yMid(60))?.kind).toBe("note-edge-r");
    expect(zoneOfNoteX({ x: 0, y: 0, w: 6, h: 16 }, 3)).toBe("note-body");
  });

  it("only hits the note on its own pitch row", () => {
    const h = createHarness();
    expect(hitAt(h, 12, h.yMid(60))?.kind).toBe("note-body");
    expect(hitAt(h, 12, h.yMid(61))?.kind).toBe("grid");
    expect(hitAt(h, 12, h.yMid(59))?.kind).toBe("grid");
  });

  it("prefers the later note where two overlap", () => {
    const h = createHarness({
      notes: [
        { id: "a", start: 0, dur: 960, pitch: 60, vel: 100 },
        { id: "b", start: 480, dur: 960, pitch: 60, vel: 100 },
      ],
    });
    const hit = hitAt(h, 30, h.yMid(60));
    expect(hit !== null && isNoteHit(hit) ? hit.noteId : null).toBe("b");
  });

  it("hits a velocity stalk within its tolerance, and the lane beyond it", () => {
    const h = createHarness();
    const stalk = hitAt(h, h.x(960), h.velY(100));
    expect(stalk?.kind).toBe("velocity-stalk");
    expect(stalk?.cursor).toBe(CURSORS.stalk);
    expect(hitAt(h, h.x(960) + 4, h.velY(100))?.kind).toBe("velocity-stalk");
    expect(hitAt(h, h.x(960) + 20, h.velY(100))?.kind).toBe("velocity-lane");
  });

  it("picks the stalk whose tip is nearest on a chord", () => {
    const h = createHarness({
      notes: [
        { id: "low", start: 960, dur: 240, pitch: 60, vel: 20 },
        { id: "high", start: 960, dur: 240, pitch: 64, vel: 120 },
      ],
    });
    const hit = hitAt(h, h.x(960), h.velY(120));
    expect(hit !== null && isNoteHit(hit) ? hit.noteId : null).toBe("high");
    const other = hitAt(h, h.x(960), h.velY(20));
    expect(other !== null && isNoteHit(other) ? other.noteId : null).toBe("low");
  });

  it("shows the pencil cursor on empty grid in pencil mode", () => {
    const h = createHarness({ tool: "pencil" });
    expect(hitAt(h, 300, h.yMid(60))?.cursor).toBe(CURSORS.gridPencil);
  });

  it("has no note zones without a clip", () => {
    const h = createHarness();
    h.ctx.clipId = null;
    expect(hitAt(h, 12, h.yMid(60))).toBeNull();
    expect(hitAt(h, 100, h.rulerY())?.kind).toBe("ruler");
  });
});

describe("hover (SS10 Idle: update hover zone + cursor)", () => {
  it("follows the pointer and drives the cursor", () => {
    const h = createHarness();
    h.move(12, h.yMid(60));
    expect(h.engine.hover?.kind).toBe("note-body");
    expect(h.engine.cursor).toBe(CURSORS.body);

    h.move(2, h.yMid(60));
    expect(h.engine.hover?.kind).toBe("note-edge-l");
    expect(h.engine.cursor).toBe(CURSORS.edge);

    h.move(400, h.yMid(60));
    expect(h.engine.hover?.kind).toBe("grid");
    expect(h.engine.cursor).toBe(CURSORS.gridSelect);
  });
});
