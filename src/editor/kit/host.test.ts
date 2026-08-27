// SS9, assembled. The host is where the four wires live, and each of them is
// a bug the previous attempts actually shipped:
//   viewport change -> canvases redraw
//   drag preview    -> OVERLAY only
//   drag commit     -> exactly one dispatch into the store (SS13)
//   container size  -> canvases and viewport stay in sync

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, CommandResult, DocumentStore } from "../../types/commands";
import type { CreateEditorHost, EditorHostOptions } from "../../types/editor";
import type { DragHandler, HitTarget, HitTester } from "../../types/gesture";
import type { EditorLayer, LayerFrame, LayerKind } from "../../types/render";
import { createEditorHost } from "./host";
import type { KitGestureEngine } from "./gestureEngine";
import { createGestureOverlayLayer } from "./overlayLayer";
import { editorPointOf, modifiers } from "./points";
import { installFakeCanvas2D } from "./testing/fakeCanvas";

beforeAll(() => {
  installFakeCanvas2D();
});

// The kit's factory satisfies the frozen `CreateEditorHost` contract shape.
const _contract: CreateEditorHost = createEditorHost;
void _contract;

interface TestHit extends HitTarget {
  readonly kind: "clip" | "lane";
}

function fakeStore(): DocumentStore & { readonly dispatched: Command[] } {
  const dispatched: Command[] = [];
  const store = {
    dispatched,
    getState: () => ({}) as ReturnType<DocumentStore["getState"]>,
    dispatch: (command: Command): CommandResult => {
      dispatched.push(command);
      return { status: "noop" };
    },
    batch: (): CommandResult => ({ status: "noop" }),
    undo: () => null,
    redo: () => null,
    canUndo: () => false,
    canRedo: () => false,
    undoLabel: () => undefined,
    redoLabel: () => undefined,
    clearHistory: () => undefined,
    onChange: () => () => undefined,
    replaceDocument: () => undefined,
    isDirty: () => false,
    markSaved: () => undefined,
  };
  return store as unknown as DocumentStore & { readonly dispatched: Command[] };
}

interface CountingLayer extends EditorLayer {
  draws: number;
}
function countingLayer(kind: LayerKind, draw?: (frame: LayerFrame) => void): CountingLayer {
  const layer: CountingLayer = {
    kind,
    draws: 0,
    draw(frame) {
      layer.draws += 1;
      draw?.(frame);
    },
  };
  return layer;
}

function setup(over: Partial<EditorHostOptions<TestHit>> = {}) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: 900, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: 300, configurable: true });
  document.body.appendChild(container);
  const store = fakeStore();

  const commitCommand: Command = { label: "Move Clips", run: () => undefined };
  const handler: DragHandler<TestHit, number> = {
    id: "move",
    claim: (start) => start.hit.kind === "clip",
    begin: () => 0,
    update: (u) => u.deltaTicks,
    commit: () => commitCommand,
    cancel: () => undefined,
  };
  const testers: readonly HitTester<TestHit>[] = [
    {
      id: "clip",
      hitTest: (point) => (point.xPx < 300 ? { kind: "clip", cursor: "grab" } : { kind: "lane" }),
    },
  ];

  const layers = {
    grid: countingLayer("grid"),
    content: countingLayer("content"),
    overlay: countingLayer("overlay"),
  };

  const host = createEditorHost<TestHit>({
    container,
    store,
    layers: [layers.grid, layers.content, layers.overlay],
    viewport: { pxPerTick: 0.05, pxPerRow: 20 },
    grid: { mode: "off" },
    hitTesters: testers,
    dragHandlers: [handler as DragHandler<TestHit, unknown>],
    dpr: 1,
    ...over,
  });

  const point = (x: number, y: number) => editorPointOf(host.viewport, x, y);
  const down = (x: number, y: number) =>
    host.gestures.pointerDown({
      pointerId: 1,
      point: point(x, y),
      button: 0,
      buttons: 1,
      modifiers: modifiers(),
    });
  const move = (x: number, y: number) =>
    host.gestures.pointerMove({
      pointerId: 1,
      point: point(x, y),
      button: 0,
      buttons: 1,
      modifiers: modifiers(),
    });
  const up = (x: number, y: number) =>
    host.gestures.pointerUp({
      pointerId: 1,
      point: point(x, y),
      button: 0,
      buttons: 0,
      modifiers: modifiers(),
    });

  return { container, store, host, layers, commitCommand, down, move, up, point };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  document.body.innerHTML = "";
  ctx = setup();
});

describe("editor host — assembly", () => {
  it("mounts one positioned element inside the container", () => {
    expect(ctx.host.element.parentElement).toBe(ctx.container);
    expect(ctx.host.element.style.position).toBe("relative");
    expect(ctx.host.renderer.element).toBe(ctx.host.element);
  });

  it("exposes viewport, grid, renderer, gestures and playhead", () => {
    expect(ctx.host.viewport.pxPerTick).toBe(0.05);
    expect(ctx.host.grid.settings.mode).toBe("off");
    expect(ctx.host.renderer.dpr).toBe(1);
    expect(ctx.host.gestures.phase).toBe("idle");
    expect(ctx.host.playhead.element.parentElement).toBe(ctx.host.element);
  });

  it("measures the container into BOTH the viewport and the canvases", () => {
    expect(ctx.host.viewport.widthPx).toBe(900);
    expect(ctx.host.viewport.heightPx).toBe(300);
    expect(ctx.host.renderer.widthPx).toBe(900);
    const canvas = ctx.host.element.querySelector("canvas");
    expect(canvas?.width).toBe(900);
  });

  it("re-measures on demand after a layout change", () => {
    Object.defineProperty(ctx.container, "clientWidth", { value: 480, configurable: true });
    ctx.host.measure();
    expect(ctx.host.viewport.widthPx).toBe(480);
    expect(ctx.host.renderer.widthPx).toBe(480);
  });

  it("is keyboard-focusable, because SS10's key map needs focus", () => {
    expect(ctx.host.element.tabIndex).toBe(0);
    ctx.host.focus();
    expect(document.activeElement).toBe(ctx.host.element);
  });

  it("sets touch-action:none so a drag is never stolen for native panning", () => {
    expect(ctx.host.element.style.touchAction).toBe("none");
  });
});

describe("editor host — the four wires", () => {
  it("a drag preview invalidates the OVERLAY only", () => {
    ctx.host.renderer.flush();
    const before = {
      grid: ctx.layers.grid.draws,
      content: ctx.layers.content.draws,
      overlay: ctx.layers.overlay.draws,
    };
    ctx.down(100, 40);
    ctx.move(200, 40);
    ctx.move(220, 40);
    ctx.host.renderer.flush();
    expect(ctx.layers.overlay.draws).toBeGreaterThan(before.overlay);
    expect(ctx.layers.grid.draws).toBe(before.grid);
    expect(ctx.layers.content.draws).toBe(before.content);
  });

  it("a viewport change invalidates the grid", () => {
    ctx.host.renderer.flush();
    const before = ctx.layers.grid.draws;
    ctx.host.viewport.scrollBy(200, 0);
    ctx.host.renderer.flush();
    expect(ctx.layers.grid.draws).toBe(before + 1);
  });

  it("a grid-settings change invalidates grid and content", () => {
    ctx.host.renderer.flush();
    const before = { grid: ctx.layers.grid.draws, content: ctx.layers.content.draws };
    ctx.host.grid.setSettings({ mode: "fixed", denominator: 8 });
    ctx.host.renderer.flush();
    expect(ctx.layers.grid.draws).toBe(before.grid + 1);
    expect(ctx.layers.content.draws).toBe(before.content + 1);
  });

  it("a committed drag dispatches EXACTLY ONE command into the store (SS13)", () => {
    ctx.down(100, 40);
    for (let x = 110; x <= 260; x += 10) ctx.move(x, 40);
    ctx.up(260, 40);
    expect(ctx.store.dispatched).toEqual([ctx.commitCommand]);
  });

  it("an aborted drag dispatches NOTHING", () => {
    ctx.down(100, 40);
    ctx.move(260, 40);
    ctx.host.gestures.cancel();
    ctx.up(260, 40);
    expect(ctx.store.dispatched).toEqual([]);
  });

  it("wheel over the host scrolls and zooms the shared viewport", () => {
    ctx.host.gestures.wheel({
      deltaX: 0,
      deltaY: 40,
      point: ctx.point(100, 100),
      modifiers: modifiers(),
    });
    expect(ctx.host.viewport.scrollRows).toBe(2); // 40 px / 20 px per row
  });
});

describe("editor host — overlay layer draws the active handler's ghosts", () => {
  it("calls drawPreview only while a drag is live", () => {
    const drawPreview = vi.fn();
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 600, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 200, configurable: true });
    document.body.appendChild(container);
    const store = fakeStore();

    const handler: DragHandler<TestHit, number> = {
      id: "ghost",
      claim: () => true,
      begin: () => 0,
      update: (u) => u.deltaTicks,
      commit: () => null,
      cancel: () => undefined,
      drawPreview,
    };

    // The overlay layer needs the engine, and the engine is created by the
    // host — so the layer reads it through a late-bound reference. This is
    // the exact pattern piano-roll/arrangement use.
    let engine: KitGestureEngine<TestHit> | null = null;
    const engineRef = {
      drawActivePreview: (frame: LayerFrame): void => {
        engine?.drawActivePreview(frame);
      },
    } as unknown as KitGestureEngine<TestHit>;
    const overlay: EditorLayer = createGestureOverlayLayer<TestHit>({ engine: engineRef });

    const host = createEditorHost<TestHit>({
      container,
      store,
      layers: [countingLayer("grid"), countingLayer("content"), overlay],
      viewport: { pxPerTick: 0.05 },
      hitTesters: [{ id: "all", hitTest: () => ({ kind: "clip" }) }],
      dragHandlers: [handler as DragHandler<TestHit, unknown>],
      dpr: 1,
    });
    engine = host.gestures;

    host.renderer.flush();
    expect(drawPreview).not.toHaveBeenCalled();

    host.gestures.pointerDown({
      pointerId: 1,
      point: editorPointOf(host.viewport, 10, 10),
      button: 0,
      buttons: 1,
      modifiers: modifiers(),
    });
    host.gestures.pointerMove({
      pointerId: 1,
      point: editorPointOf(host.viewport, 90, 10),
      button: 0,
      buttons: 1,
      modifiers: modifiers(),
    });
    host.renderer.flush();
    expect(drawPreview).toHaveBeenCalledTimes(1);
    expect(drawPreview.mock.calls[0]?.[1]).toBe(1600); // 80 px = 1600 ticks
    host.dispose();
  });
});

describe("editor host — lifecycle", () => {
  it("dispose tears down the DOM and goes inert", () => {
    ctx.host.dispose();
    expect(ctx.container.querySelector("canvas")).toBeNull();
    expect(ctx.container.querySelector(".fbl-playhead")).toBeNull();
    ctx.down(100, 40);
    expect(ctx.host.gestures.phase).toBe("idle");
    expect(ctx.store.dispatched).toEqual([]);
  });

  it("dispose is idempotent", () => {
    ctx.host.dispose();
    expect(() => {
      ctx.host.dispose();
    }).not.toThrow();
  });
});
