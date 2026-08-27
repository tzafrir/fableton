// SS9's layer discipline, piano-roll skin: what each layer draws, and — the
// load-bearing half — what it does NOT redraw. Assertions run against the
// kit's recording 2D context, so they read the draw calls, not pixels.

import { beforeAll, describe, expect, it } from "vitest";
import type { LayerFrame } from "../../types/render";
import { fakeContextOf, installFakeCanvas2D } from "../kit/testing/fakeCanvas";
import {
  createPianoRollContentLayer,
  createPianoRollGridLayer,
  createPianoRollOverlayLayer,
} from "./layers";
import { createHarness, type Harness } from "./testing/harness";

beforeAll(() => {
  installFakeCanvas2D();
});

function frameOf(h: Harness): { frame: LayerFrame; ctx: ReturnType<typeof fakeContextOf> } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  return {
    frame: {
      ctx,
      viewport: h.viewport,
      widthPx: h.viewport.widthPx,
      heightPx: h.viewport.heightPx,
      dpr: 1,
      time: 0,
    },
    ctx: fakeContextOf(canvas),
  };
}

describe("grid layer", () => {
  it("draws rows, time lines, the ruler and the lane chrome", () => {
    const h = createHarness();
    const { frame, ctx } = frameOf(h);
    createPianoRollGridLayer(() => h.ctx).draw(frame);
    const ops = ctx.ops();
    expect(ops.filter((op) => op === "fillRect").length).toBeGreaterThan(10);
    expect(ops).toContain("stroke");
    expect(ops).toContain("fillText"); // bar numbers
    expect(ops.filter((op) => op === "save").length).toBe(
      ops.filter((op) => op === "restore").length,
    );
  });

  it("leaves no clip region behind (save/restore balance) at any size", () => {
    const h = createHarness({ heightPx: 60 });
    const { frame, ctx } = frameOf(h);
    createPianoRollGridLayer(() => h.ctx).draw(frame);
    expect(ctx.ops().filter((op) => op === "save").length).toBe(
      ctx.ops().filter((op) => op === "restore").length,
    );
  });
});

describe("content layer", () => {
  it("culls to the visible tick window (SS9 binary search)", () => {
    const notes = [
      { id: "in", start: 0, dur: 480, pitch: 60, vel: 100 },
      { id: "far", start: 200_000, dur: 480, pitch: 60, vel: 100 },
      { id: "further", start: 400_000, dur: 480, pitch: 60, vel: 100 },
    ];
    const h = createHarness({ notes });
    const { frame, ctx } = frameOf(h);
    createPianoRollContentLayer(() => h.ctx).draw(frame);
    // One note rectangle, one outline; the two off-screen notes cost nothing.
    expect(ctx.callsOf("fillRect")).toHaveLength(1);
    expect(ctx.callsOf("strokeRect")).toHaveLength(1);
  });

  it("draws one velocity stalk per visible note", () => {
    const h = createHarness();
    const { frame, ctx } = frameOf(h);
    createPianoRollContentLayer(() => h.ctx).draw(frame);
    // Two notes: two rectangles' worth of strokes plus two stalks.
    expect(ctx.callsOf("moveTo")).toHaveLength(2);
  });

  it("rebuilds its index only when the notes array changes", () => {
    const h = createHarness();
    const layer = createPianoRollContentLayer(() => h.ctx);
    const first = frameOf(h);
    layer.draw(first.frame);
    const before = first.ctx.callsOf("fillRect").length;

    const second = frameOf(h);
    layer.draw(second.frame);
    expect(second.ctx.callsOf("fillRect")).toHaveLength(before);
  });
});

describe("overlay layer", () => {
  it("draws selected notes, and nothing else when idle", () => {
    const h = createHarness();
    const empty = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, { previewOf: () => null }).draw(empty.frame);
    expect(empty.ctx.callsOf("fillRect")).toHaveLength(0);

    h.ctx.selection.set(["n1"]);
    const selected = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, { previewOf: () => null }).draw(selected.frame);
    expect(selected.ctx.callsOf("fillRect")).toHaveLength(1);
  });

  it("draws the drag ghosts of the live gesture", () => {
    const h = createHarness();
    h.down(12, h.yMid(60));
    h.move(24, h.yMid(60));
    const { frame, ctx } = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, {
      previewOf: () => h.engine.preview,
    }).draw(frame);
    // One selected note + one ghost.
    expect(ctx.callsOf("fillRect")).toHaveLength(2);
  });

  it("draws the marquee rectangle", () => {
    const h = createHarness();
    h.down(400, h.yMid(66));
    h.move(300, h.yMid(62));
    const { frame, ctx } = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, {
      previewOf: () => h.engine.preview,
    }).draw(frame);
    const fills = ctx.callsOf("fillRect");
    expect(fills.length).toBeGreaterThanOrEqual(1);
    expect(fills[fills.length - 1]?.args).toEqual([300, expect.any(Number), 100, expect.any(Number)]);
  });
});
