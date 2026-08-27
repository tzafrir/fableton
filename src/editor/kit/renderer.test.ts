// SS9's rendering stack, asserted where it matters: the dirty flags (a 2,000
// note content layer must NOT redraw because a ghost moved), the dpr scaling
// and half-pixel alignment, and the DOM playhead that never invalidates a
// canvas.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EditorLayer, LayerFrame, LayerKind } from "../../types/render";
import { LAYER_ORDER, alignHalfPixel, alignPixel, createRenderer } from "./renderer";
import { createPlayheadView } from "./playhead";
import { createViewport } from "./viewport";
import {
  createManualFramePump,
  fakeContextOf,
  installFakeCanvas2D,
} from "./testing/fakeCanvas";

beforeAll(() => {
  installFakeCanvas2D();
});

interface CountingLayer extends EditorLayer {
  draws: number;
  lastFrame: LayerFrame | null;
}

function countingLayer(kind: LayerKind, onDraw?: (frame: LayerFrame) => void): CountingLayer {
  const layer: CountingLayer = {
    kind,
    draws: 0,
    lastFrame: null,
    draw(frame) {
      layer.draws += 1;
      layer.lastFrame = frame;
      onDraw?.(frame);
    },
  };
  return layer;
}

function setup(dpr = 2) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const viewport = createViewport({ widthPx: 800, heightPx: 400 });
  const pump = createManualFramePump();
  const layers = {
    grid: countingLayer("grid"),
    content: countingLayer("content"),
    overlay: countingLayer("overlay"),
  };
  const renderer = createRenderer({
    container,
    viewport,
    layers: [layers.grid, layers.content, layers.overlay],
    dpr,
    requestFrame: pump.requestFrame,
    cancelFrame: pump.cancelFrame,
  });
  renderer.resize(800, 400);
  return { container, viewport, renderer, pump, layers };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  document.body.innerHTML = "";
  ctx = setup();
});

describe("renderer — the canvas stack", () => {
  it("creates one canvas per layer, bottom to top, none of them clickable", () => {
    const canvases = [...ctx.renderer.element.querySelectorAll("canvas")];
    expect(canvases).toHaveLength(3);
    expect(canvases.map((c) => c.className)).toEqual([
      "fbl-layer fbl-layer-grid",
      "fbl-layer fbl-layer-content",
      "fbl-layer fbl-layer-overlay",
    ]);
    expect(canvases.map((c) => c.style.zIndex)).toEqual(["1", "2", "3"]);
    // Hit-testing is explicit math against the model, not elementFromPoint.
    expect(canvases.every((c) => c.style.pointerEvents === "none")).toBe(true);
  });

  it("declares the SS9 layer order", () => {
    expect(LAYER_ORDER).toEqual(["grid", "content", "overlay"]);
  });

  it("sizes the backing store in DEVICE pixels and the box in CSS pixels", () => {
    const canvas = ctx.renderer.element.querySelector("canvas");
    expect(canvas?.width).toBe(1600); // 800 CSS px * dpr 2
    expect(canvas?.height).toBe(800);
    expect(canvas?.style.width).toBe("800px");
    expect(canvas?.style.height).toBe("400px");
  });

  it("pre-scales the context by dpr, so layers draw in CSS pixels only", () => {
    const canvas = ctx.renderer.element.querySelector("canvas") as HTMLCanvasElement;
    const fake = fakeContextOf(canvas);
    const scaling = fake.callsOf("setTransform").filter((c) => c.args[0] === 2);
    expect(scaling.length).toBeGreaterThan(0);
    expect(scaling[0]?.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("hands each layer a frame in CSS pixels with the dpr alongside", () => {
    ctx.renderer.invalidateAll();
    ctx.pump.runFrame(16);
    const frame = ctx.layers.grid.lastFrame;
    expect(frame?.widthPx).toBe(800);
    expect(frame?.heightPx).toBe(400);
    expect(frame?.dpr).toBe(2);
    expect(frame?.viewport).toBe(ctx.viewport);
    expect(frame?.time).toBe(16);
  });
});

describe("renderer — dirty flags on rAF (SS9)", () => {
  it("draws every layer once on the first frame", () => {
    ctx.pump.runFrame();
    expect(ctx.layers.grid.draws).toBe(1);
    expect(ctx.layers.content.draws).toBe(1);
    expect(ctx.layers.overlay.draws).toBe(1);
  });

  it("invalidating the overlay leaves grid and content ALONE", () => {
    ctx.pump.runFrame();
    for (let i = 0; i < 60; i += 1) {
      ctx.renderer.invalidate("overlay");
      ctx.pump.runFrame();
    }
    expect(ctx.layers.overlay.draws).toBe(61);
    expect(ctx.layers.grid.draws).toBe(1);
    expect(ctx.layers.content.draws).toBe(1);
  });

  it("a DATA change redraws content only, never the grid", () => {
    ctx.pump.runFrame();
    ctx.renderer.invalidate("content");
    ctx.pump.runFrame();
    expect(ctx.layers.content.draws).toBe(2);
    expect(ctx.layers.grid.draws).toBe(1);
  });

  it("a VIEWPORT change redraws the grid too", () => {
    ctx.pump.runFrame();
    ctx.viewport.scrollBy(120, 0);
    ctx.pump.runFrame();
    expect(ctx.layers.grid.draws).toBe(2);
    expect(ctx.layers.content.draws).toBe(2);
  });

  it("coalesces many invalidations into ONE redraw per frame", () => {
    ctx.pump.runFrame();
    for (let i = 0; i < 20; i += 1) ctx.renderer.invalidate("content");
    expect(ctx.pump.pending).toBe(1);
    ctx.pump.runFrame();
    expect(ctx.layers.content.draws).toBe(2);
  });

  it("redraws in LAYER_ORDER within a frame", () => {
    const order: string[] = [];
    const container = document.createElement("div");
    const viewport = createViewport({ widthPx: 100, heightPx: 100 });
    const pump = createManualFramePump();
    const renderer = createRenderer({
      container,
      viewport,
      // Deliberately registered top-first; the renderer still draws bottom-up.
      layers: [
        countingLayer("overlay", () => order.push("overlay")),
        countingLayer("grid", () => order.push("grid")),
        countingLayer("content", () => order.push("content")),
      ],
      dpr: 1,
      requestFrame: pump.requestFrame,
      cancelFrame: pump.cancelFrame,
    });
    pump.runFrame();
    expect(order).toEqual(["grid", "content", "overlay"]);
    renderer.dispose();
  });

  it("clears a layer before drawing it", () => {
    const canvas = ctx.renderer.element.querySelector("canvas") as HTMLCanvasElement;
    const fake = fakeContextOf(canvas);
    fake.reset();
    ctx.renderer.invalidate("grid");
    ctx.pump.runFrame();
    expect(fake.callsOf("clearRect")[0]?.args).toEqual([0, 0, 1600, 800]);
  });

  it("brackets a layer's draw in save/restore so it cannot leak ctx state", () => {
    const canvas = ctx.renderer.element.querySelector("canvas") as HTMLCanvasElement;
    const fake = fakeContextOf(canvas);
    fake.reset();
    ctx.renderer.invalidate("grid");
    ctx.pump.runFrame();
    const ops = fake.ops();
    expect(ops[0]).toBe("save");
    expect(ops[ops.length - 1]).toBe("restore");
  });

  it("restores ctx state even when a layer throws", () => {
    const container = document.createElement("div");
    const viewport = createViewport({ widthPx: 10, heightPx: 10 });
    const pump = createManualFramePump();
    const boom: EditorLayer = {
      kind: "grid",
      draw: () => {
        throw new Error("layer exploded");
      },
    };
    const renderer = createRenderer({
      container,
      viewport,
      layers: [boom],
      dpr: 1,
      requestFrame: pump.requestFrame,
      cancelFrame: pump.cancelFrame,
    });
    const canvas = renderer.element.querySelector("canvas") as HTMLCanvasElement;
    const fake = fakeContextOf(canvas);
    expect(() => {
      pump.runFrame();
    }).toThrow("layer exploded");
    expect(fake.ops()).toContain("restore");
    renderer.dispose();
  });

  it("flush draws synchronously and cancels the pending frame", () => {
    ctx.pump.runFrame();
    ctx.renderer.invalidate("content");
    ctx.renderer.flush();
    expect(ctx.layers.content.draws).toBe(2);
    expect(ctx.pump.pending).toBe(0);
  });

  it("resize re-applies the device size and invalidates everything", () => {
    ctx.pump.runFrame();
    ctx.renderer.resize(400, 200);
    expect(ctx.renderer.widthPx).toBe(400);
    const canvas = ctx.renderer.element.querySelector("canvas");
    expect(canvas?.width).toBe(800);
    ctx.pump.runFrame();
    expect(ctx.layers.grid.draws).toBe(2);
  });

  it("a no-op resize does not schedule a frame", () => {
    ctx.pump.runFrame();
    ctx.renderer.resize(800, 400);
    expect(ctx.pump.pending).toBe(0);
  });

  it("dispose detaches the element, disposes layers and stops drawing", () => {
    const disposed: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const viewport = createViewport({ widthPx: 10, heightPx: 10 });
    const pump = createManualFramePump();
    const layer: EditorLayer = {
      kind: "grid",
      draw: () => undefined,
      dispose: () => disposed.push("grid"),
    };
    const renderer = createRenderer({
      container,
      viewport,
      layers: [layer],
      dpr: 1,
      requestFrame: pump.requestFrame,
      cancelFrame: pump.cancelFrame,
    });
    renderer.dispose();
    expect(disposed).toEqual(["grid"]);
    expect(container.querySelector("canvas")).toBeNull();
    renderer.invalidateAll();
    expect(pump.pending).toBe(0);
  });
});

describe("renderer — crisp lines (SS9 half-pixel alignment)", () => {
  it("alignHalfPixel centres a 1-px stroke on one device column", () => {
    expect(alignHalfPixel(10)).toBe(10.5);
    expect(alignHalfPixel(10.4)).toBe(10.5);
    expect(alignHalfPixel(10.6)).toBe(11.5);
    expect(alignHalfPixel(-3.2)).toBe(-2.5);
  });

  it("alignPixel snaps a fill edge to a whole pixel", () => {
    expect(alignPixel(10.4)).toBe(10);
    expect(alignPixel(10.6)).toBe(11);
  });

  it("every aligned coordinate has a .5 fractional part", () => {
    for (let i = -20; i < 20; i += 0.37) {
      expect(Math.abs(alignHalfPixel(i) % 1)).toBe(0.5);
    }
  });
});

describe("playhead — a DOM node, never a canvas repaint (SS9 layer 4)", () => {
  it("positions via transform: translateX and sits above every canvas", () => {
    const playhead = createPlayheadView({
      container: ctx.renderer.element,
      viewport: ctx.viewport,
    });
    ctx.pump.runFrame();
    const drawsBefore = [
      ctx.layers.grid.draws,
      ctx.layers.content.draws,
      ctx.layers.overlay.draws,
    ];
    playhead.setTicks(19_200); // 5 bars at 0.05 px/tick = 960 px
    expect(playhead.element.style.transform).toBe("translateX(960px)");
    expect(Number(playhead.element.style.zIndex)).toBeGreaterThan(3);
    // The whole point: no layer was invalidated, so nothing is pending.
    expect(ctx.pump.pending).toBe(0);
    ctx.pump.runFrame();
    expect([
      ctx.layers.grid.draws,
      ctx.layers.content.draws,
      ctx.layers.overlay.draws,
    ]).toEqual(drawsBefore);
    playhead.dispose();
  });

  it("rounds to a whole pixel so it does not shimmer while playing", () => {
    const playhead = createPlayheadView({
      container: ctx.renderer.element,
      viewport: ctx.viewport,
    });
    playhead.setTicks(101); // 5.05 px
    expect(playhead.element.style.transform).toBe("translateX(5px)");
    playhead.dispose();
  });

  it("follows a scroll/zoom without touching a canvas", () => {
    const playhead = createPlayheadView({
      container: ctx.renderer.element,
      viewport: ctx.viewport,
    });
    playhead.setTicks(19_200);
    ctx.viewport.setScroll(9600, 0);
    expect(playhead.element.style.transform).toBe("translateX(480px)");
    playhead.dispose();
  });

  it("hides and shows, and detaches on dispose", () => {
    const playhead = createPlayheadView({
      container: ctx.renderer.element,
      viewport: ctx.viewport,
    });
    playhead.setVisible(false);
    expect(playhead.element.style.display).toBe("none");
    playhead.setVisible(true);
    expect(playhead.element.style.display).toBe("block");
    playhead.dispose();
    expect(ctx.renderer.element.querySelector(".fbl-playhead")).toBeNull();
  });
});
