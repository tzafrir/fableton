// SS9's overlay layer, arrangement skin: "selection, marquee, drag ghosts; the
// ONLY layer redrawing at 60 fps during a gesture."
//
// These are the drawing routines every arrangement drag hands its preview to
// (`DragHandler.drawPreview`), so what is asserted here is what the user
// actually sees mid-gesture: ghost geometry in MUSICAL units, the loop brace,
// the marquee rectangle — and the culling that keeps the 60 fps layer O(visible).

import { beforeAll, describe, expect, it } from "vitest";
import type { LayerFrame } from "../../types/render";
import type { Modifiers } from "../../types/gesture";
import { createViewport } from "../kit";
import { modifiers } from "../kit";
import { fakeContextOf, installFakeCanvas2D } from "../kit/testing/fakeCanvas";
import { DEFAULT_THEME } from "./constants";
import type { ClipGhost } from "./edits";
import { drawClipOutline, drawGhosts, drawMarquee } from "./ghosts";
import { BAR, CLIP_1, createHarness } from "./testing/harness";

beforeAll(() => {
  installFakeCanvas2D();
});

const NO_MODS: Modifiers = modifiers({});

function frameOf(pxPerTick = 0.05, pxPerRow = 40, widthPx = 800) {
  const viewport = createViewport({ pxPerTick, pxPerRow, widthPx, heightPx: 200 });
  const canvas = document.createElement("canvas");
  const raw = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  const frame: LayerFrame = { ctx: raw, viewport, widthPx, heightPx: 200, dpr: 1, time: 0 };
  return { frame, viewport, ctx: fakeContextOf(canvas) };
}

const ghost = (over: Partial<ClipGhost> = {}): ClipGhost => ({
  clipId: CLIP_1,
  row: 0,
  start: 0,
  length: BAR,
  loop: null,
  label: "",
  ...over,
});

describe("drawGhosts", () => {
  it("draws a translucent body plus an outline per ghost, in tick space", () => {
    const { frame, ctx } = frameOf();
    drawGhosts(frame, DEFAULT_THEME, [ghost({ start: BAR })]);
    const fills = ctx.callsOf("fillRect");
    expect(fills).toHaveLength(1);
    // x = 3840 * 0.05, w = 3840 * 0.05 (y carries the lane's inset)
    expect(fills[0]?.args[0]).toBe(192);
    expect(fills[0]?.args[2]).toBe(192);
    expect(ctx.callsOf("strokeRect")).toHaveLength(1);
  });

  it("follows a scrolled viewport (ghosts are glued to ticks, not pixels)", () => {
    const { frame, viewport, ctx } = frameOf();
    viewport.setScroll(BAR, 0);
    drawGhosts(frame, DEFAULT_THEME, [ghost({ start: BAR })]);
    expect(ctx.callsOf("fillRect")[0]?.args[0]).toBe(0);
  });

  it("culls ghosts outside the frame (SS9's 60 fps layer)", () => {
    const { frame, ctx } = frameOf();
    drawGhosts(frame, DEFAULT_THEME, [
      ghost({ start: 0 }),
      ghost({ start: BAR * 100 }), // far right
      ghost({ start: -BAR * 100 }), // far left
    ]);
    expect(ctx.callsOf("fillRect")).toHaveLength(1);
  });

  it("draws the loop brace of a ghost that carries one", () => {
    const { frame, ctx } = frameOf();
    const plain = frameOf();
    drawGhosts(plain.frame, DEFAULT_THEME, [ghost()]);
    drawGhosts(frame, DEFAULT_THEME, [ghost({ loop: { start: 0, end: BAR / 2 } })]);
    expect(ctx.callsOf("fillRect").length).toBe(plain.ctx.callsOf("fillRect").length + 1);
    // The brace spans the loop window, in the ghost's own coordinates.
    expect(ctx.callsOf("fillRect").at(-1)?.args.slice(0, 1)).toEqual([0]);
  });
});

describe("drawMarquee", () => {
  it("normalizes the rectangle and draws it in tick/row space", () => {
    const { frame, ctx } = frameOf();
    drawMarquee(frame, DEFAULT_THEME, BAR * 2, BAR, 2, 0);
    expect(ctx.callsOf("fillRect")[0]?.args).toEqual([192, 0, 192, 80]);
    expect(ctx.callsOf("strokeRect")).toHaveLength(1);
  });
});

describe("drawClipOutline", () => {
  it("culls an outline that is off screen", () => {
    const { frame, ctx } = frameOf();
    drawClipOutline(frame, 0, BAR * 100, BAR, DEFAULT_THEME.selectionOutline);
    expect(ctx.callsOf("strokeRect")).toHaveLength(0);
  });
});

// The other half of the omission: every arrangement verb routes its preview
// through these functions via `DragHandler.drawPreview`, which the kit calls
// from the overlay layer (`gestures.drawActivePreview`).
describe("drawPreview, through a live gesture", () => {
  const drawActive = (h: ReturnType<typeof createHarness>) => {
    const canvas = document.createElement("canvas");
    const raw = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    h.engine.drawActivePreview({
      ctx: raw,
      viewport: h.viewport,
      widthPx: h.viewport.widthPx,
      heightPx: h.viewport.heightPx,
      dpr: 1,
      time: 0,
    });
    return fakeContextOf(canvas);
  };

  it("draws the move ghosts of a live clip drag", () => {
    const h = createHarness();
    h.down(100, 20);
    h.move(300, 20);
    expect(drawActive(h).callsOf("fillRect").length).toBeGreaterThan(0);
  });

  it("draws the marquee of a live Shift-drag", () => {
    const h = createHarness();
    h.down(600, 20, { shift: true });
    h.move(200, 60, { shift: true });
    const ctx = drawActive(h);
    expect(ctx.callsOf("fillRect")).toHaveLength(1);
    expect(ctx.callsOf("strokeRect")).toHaveLength(1);
  });

  it("draws nothing once the gesture is over", () => {
    const h = createHarness();
    h.down(100, 20);
    h.move(300, 20);
    h.up(300, 20);
    expect(drawActive(h).calls).toHaveLength(0);
  });

  it("draws the create ghost of a live lane drag", () => {
    const h = createHarness();
    h.down(600, 20, NO_MODS);
    h.move(760, 20, NO_MODS);
    expect(drawActive(h).callsOf("fillRect").length).toBeGreaterThan(0);
  });
});
