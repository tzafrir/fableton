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
    // One note rectangle (plus the dim tail past the clip's end), one outline;
    // the two off-screen notes cost nothing.
    expect(ctx.callsOf("fillRect")).toHaveLength(2);
    expect(ctx.callsOf("strokeRect")).toHaveLength(1);
  });

  // SS9 fixes the GRID layer's only redraw trigger as a viewport change, so
  // the "past the end of the clip" dim — which is document-derived — has to
  // live here, where a data change repaints it. Before this it was drawn in
  // the grid layer and a trim left the shading at the old length.
  it("dims past the clip's end, and follows a length change", () => {
    const h = createHarness();
    const layer = createPianoRollContentLayer(() => h.ctx);
    const before = frameOf(h);
    layer.draw(before.frame);
    // The dim is drawn first, UNDER the notes.
    const dimBefore = before.ctx.callsOf("fillRect").at(0)?.args[0];
    expect(dimBefore).toBe(h.x(h.ctx.clipLength()));

    h.store.dispatch(
      h.ctx.commands.trimClips([{ id: h.clipId, start: 0, length: 960 }]),
    );
    const after = frameOf(h);
    layer.draw(after.frame);
    expect(after.ctx.callsOf("fillRect").at(0)?.args[0]).toBe(h.x(960));
    expect(after.ctx.callsOf("fillRect").at(0)?.args[0]).not.toBe(dimBefore);
  });

  it("draws one velocity stalk per visible note", () => {
    const h = createHarness();
    const { frame, ctx } = frameOf(h);
    createPianoRollContentLayer(() => h.ctx).draw(frame);
    // Two notes: two rectangles' worth of strokes plus two stalks.
    expect(ctx.callsOf("moveTo")).toHaveLength(2);
  });

  // SS9's layer rules in one sentence: content redraws on DATA or viewport
  // change, selection lives in the OVERLAY. A selection-dependent colour in
  // this layer is a dead feature, because `selection.onChange` only ever
  // invalidates the overlay (pianoRoll.ts).
  it("paints velocity stalks the same whether or not a note is selected", () => {
    const h = createHarness();
    const layer = createPianoRollContentLayer(() => h.ctx);
    const before = frameOf(h);
    layer.draw(before.frame);
    const plain = before.ctx.calls.map((call) => `${call.op}:${JSON.stringify(call.args)}`);

    h.ctx.selection.set(["n1"]);
    const after = frameOf(h);
    layer.draw(after.frame);
    expect(after.ctx.calls.map((call) => `${call.op}:${JSON.stringify(call.args)}`)).toEqual(plain);
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

  it("tints the SELECTED note's velocity stalk (the content layer never does)", () => {
    const h = createHarness();
    const idle = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, { previewOf: () => null }).draw(idle.frame);
    const idleStrokes = idle.ctx.callsOf("stroke").length;

    h.ctx.selection.set(["n1"]);
    const selected = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, { previewOf: () => null }).draw(selected.frame);
    // The selected note's outline plus its stalk.
    expect(selected.ctx.callsOf("stroke").length).toBe(idleStrokes + 1);
    expect(selected.ctx.callsOf("strokeRect")).toHaveLength(1);
  });

  it("culls the selection scan to the visible window (SS2's 2,000 notes)", () => {
    const notes = Array.from({ length: 2000 }, (_, i) => ({
      id: `n${String(i)}`,
      start: i * 120,
      dur: 120,
      pitch: 60,
      vel: 100,
    }));
    const h = createHarness({ notes });
    h.ctx.selection.set(notes.map((note) => note.id));
    const { frame, ctx } = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, { previewOf: () => null }).draw(frame);
    // The overlay is the only layer that redraws at 60 fps during a gesture,
    // so "all 2,000 notes selected" must still cost O(visible) draw calls.
    expect(ctx.callsOf("fillRect").length).toBeLessThan(200);
    expect(ctx.callsOf("fillRect").length).toBeGreaterThan(0);
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

  // SS9 makes the overlay "the ONLY layer redrawing at 60 fps during a
  // gesture", and SS2's budget is stated in VISIBLE notes — but a drag preview
  // covers the whole SELECTION (Cmd+A on a long clip), most of which is off
  // screen. Ghosts cull exactly like the content layer.
  it("culls the drag ghosts to the visible window", () => {
    const notes = Array.from({ length: 2000 }, (_, i) => ({
      id: `n${String(i)}`,
      start: i * 120,
      dur: 120,
      pitch: 60,
      vel: 100,
    }));
    const h = createHarness({ notes });
    h.ctx.selection.set(notes.map((note) => note.id));
    // Grab one note's body and drag: the preview now holds 2,000 ghosts.
    h.down(2, h.yMid(60));
    h.move(30, h.yMid(60));
    const preview = h.engine.preview as { ghosts: readonly unknown[] };
    expect(preview.ghosts).toHaveLength(2000);

    const { frame, ctx } = frameOf(h);
    createPianoRollOverlayLayer(() => h.ctx, {
      previewOf: () => h.engine.preview,
    }).draw(frame);
    // Selected notes + ghosts, both O(visible) — not O(selection).
    expect(ctx.callsOf("fillRect").length).toBeLessThan(400);
    expect(ctx.callsOf("fillRect").length).toBeGreaterThan(0);
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
