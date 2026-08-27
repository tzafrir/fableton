// SS15: "gesture FSMs are unit-tested by feeding synthetic pointer-event
// sequences" — no DOM element, no browser, no canvas. Every assertion below
// is about a rule SS9/SS10 fixes: threshold promotion, ghost-only previews,
// EXACTLY ONE command on release, Esc aborting with zero document traffic,
// and the uniform wheel bindings.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../types/commands";
import type {
  ClickInfo,
  DragHandler,
  DragUpdate,
  EditorPoint,
  GestureStart,
  HitTarget,
  HitTester,
  KeyBinding,
  Modifiers,
  PointerInput,
} from "../../types/gesture";
import { DRAG_THRESHOLD_PX } from "../../types/gesture";
import type { Grid, Viewport } from "../../types/viewport";
import { createGrid } from "./grid";
import { createKitGestureEngine } from "./gestureEngine";
import { editorPointOf, modifiers } from "./points";
import { createViewport } from "./viewport";

// --- fixtures ---------------------------------------------------------------

interface TestHit extends HitTarget {
  readonly kind: "note" | "edge" | "empty";
  readonly id?: string;
}

interface Preview {
  readonly deltaTicks: number;
  readonly deltaRows: number;
  readonly frames: number;
}

function command(label: string): Command {
  return { label, run: () => undefined };
}

interface Harness {
  viewport: Viewport;
  grid: Grid;
  engine: ReturnType<typeof createKitGestureEngine<TestHit>>;
  dispatched: Command[];
  overlayInvalidations: number;
  point(xPx: number, yPx: number): EditorPoint;
  down(xPx: number, yPx: number, over?: Partial<PointerInput>): void;
  move(xPx: number, yPx: number, over?: Partial<PointerInput>): void;
  up(xPx: number, yPx: number, over?: Partial<PointerInput>): void;
  handler: RecordingHandler;
}

interface RecordingHandler extends DragHandler<TestHit, Preview> {
  readonly log: string[];
  commandOnCommit: Command | null;
  commandOnClick: Command | null;
  lastCommit: DragUpdate<TestHit, Preview> | null;
  lastClick: ClickInfo | null;
  cancelledWith: Preview | null;
}

function recordingHandler(
  overrides: Partial<DragHandler<TestHit, Preview>> = {},
): RecordingHandler {
  const log: string[] = [];
  const handler: RecordingHandler = {
    id: "test.move",
    log,
    commandOnCommit: command("Move Notes"),
    commandOnClick: null,
    lastCommit: null,
    lastClick: null,
    cancelledWith: null,
    claim: (start: GestureStart<TestHit>) => start.hit.kind !== "empty",
    begin: () => {
      log.push("begin");
      return { deltaTicks: 0, deltaRows: 0, frames: 0 };
    },
    update: (u) => {
      log.push("update");
      return {
        deltaTicks: u.grid.snapDelta(u.deltaTicks),
        deltaRows: Math.round(u.deltaRows),
        frames: u.preview.frames + 1,
      };
    },
    commit: (u) => {
      log.push("commit");
      handler.lastCommit = u;
      return handler.commandOnCommit;
    },
    cancel: (preview) => {
      log.push("cancel");
      handler.cancelledWith = preview;
    },
    click: (_start, info) => {
      log.push("click");
      handler.lastClick = info;
      return handler.commandOnClick;
    },
    ...overrides,
  };
  return handler;
}

function harness(
  options: {
    handler?: RecordingHandler;
    hitTesters?: readonly HitTester<TestHit>[];
    keyBindings?: readonly KeyBinding[];
  } = {},
): Harness {
  const viewport = createViewport({
    pxPerTick: 0.05, // 1 px = 20 ticks
    pxPerRow: 16,
    widthPx: 800,
    heightPx: 400,
  });
  const grid = createGrid({ viewport, settings: { mode: "off" } });
  const dispatched: Command[] = [];
  const handler = options.handler ?? recordingHandler();
  const h = {
    overlayInvalidations: 0,
  } as { overlayInvalidations: number };

  const defaultTesters: readonly HitTester<TestHit>[] = [
    {
      id: "note",
      priority: 10,
      hitTest: (point) =>
        point.xPx >= 100 && point.xPx < 200 ? { kind: "note", id: "n1", cursor: "grab" } : null,
    },
    { id: "empty", priority: -10, hitTest: () => ({ kind: "empty", cursor: "crosshair" }) },
  ];

  const engine = createKitGestureEngine<TestHit>({
    viewport,
    grid,
    dispatch: (c) => {
      dispatched.push(c);
    },
    invalidateOverlay: () => {
      h.overlayInvalidations += 1;
    },
    hitTesters: options.hitTesters ?? defaultTesters,
    dragHandlers: [handler as DragHandler<TestHit, unknown>],
    keyBindings: options.keyBindings ?? [],
  });

  const point = (xPx: number, yPx: number) => editorPointOf(viewport, xPx, yPx);
  const input = (xPx: number, yPx: number, over: Partial<PointerInput>): PointerInput => ({
    pointerId: 1,
    point: point(xPx, yPx),
    button: 0,
    buttons: 1,
    modifiers: modifiers(),
    clickCount: 1,
    ...over,
  });

  return {
    viewport,
    grid,
    engine,
    dispatched,
    get overlayInvalidations() {
      return h.overlayInvalidations;
    },
    point,
    handler,
    down: (x, y, over = {}) => {
      engine.pointerDown(input(x, y, over));
    },
    move: (x, y, over = {}) => {
      engine.pointerMove(input(x, y, over));
    },
    up: (x, y, over = {}) => {
      engine.pointerUp(input(x, y, { buttons: 0, ...over }));
    },
  };
}

// --- the FSM ----------------------------------------------------------------

describe("gesture engine — phases (SS10's table, collapsed)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("starts idle with no hover, no preview, no active handler", () => {
    expect(h.engine.phase).toBe("idle");
    expect(h.engine.hover).toBeNull();
    expect(h.engine.preview).toBeNull();
    expect(h.engine.activeHandlerId).toBeNull();
  });

  it("hover hit-tests on move and drives the cursor (SS10)", () => {
    h.move(150, 50);
    expect(h.engine.hover?.kind).toBe("note");
    expect(h.engine.cursor).toBe("grab");
    h.move(400, 50);
    expect(h.engine.hover?.kind).toBe("empty");
    expect(h.engine.cursor).toBe("crosshair");
  });

  it("pointerdown on a claimed hit goes to `pending`, not `dragging`", () => {
    h.down(150, 50);
    expect(h.engine.phase).toBe("pending");
    expect(h.engine.preview).toBeNull();
    expect(h.handler.log).toEqual([]);
  });

  it("does nothing when no hit-tester resolves the point", () => {
    const bare = harness({ hitTesters: [{ id: "none", hitTest: () => null }] });
    bare.down(150, 50);
    expect(bare.engine.phase).toBe("idle");
  });

  it("does nothing when no handler claims the hit", () => {
    h.down(400, 50); // 'empty' — the recording handler declines it
    expect(h.engine.phase).toBe("idle");
    expect(h.engine.activeHandlerId).toBeNull();
  });

  it("suppresses hover while a gesture owns the pointer", () => {
    h.down(150, 50);
    h.move(160, 50);
    expect(h.engine.hover).toBeNull();
  });
});

describe("gesture engine — the promotion threshold (DRAG_THRESHOLD_PX = 3)", () => {
  it("does NOT promote at or below the threshold", () => {
    const h = harness();
    h.down(150, 50);
    h.move(150 + DRAG_THRESHOLD_PX, 50);
    expect(h.engine.phase).toBe("pending");
    expect(h.handler.log).toEqual([]);
  });

  it("promotes past the threshold and begins exactly once", () => {
    const h = harness();
    h.down(150, 50);
    h.move(154, 50);
    expect(h.engine.phase).toBe("dragging");
    expect(h.engine.activeHandlerId).toBe("test.move");
    h.move(160, 50);
    h.move(170, 50);
    expect(h.handler.log.filter((e) => e === "begin")).toHaveLength(1);
  });

  it("measures travel radially, not per axis", () => {
    const h = harness();
    h.down(150, 50);
    h.move(152, 52); // hypot = 2.83 <= 3
    expect(h.engine.phase).toBe("pending");
    h.move(153, 53); // hypot = 4.24 > 3
    expect(h.engine.phase).toBe("dragging");
  });

  it("feeds the promoting move straight through, so the ghost is never a frame late", () => {
    const h = harness();
    h.down(150, 50);
    h.move(200, 50); // +50 px = +1000 ticks
    expect((h.engine.preview as Preview).deltaTicks).toBe(1000);
    expect(h.handler.log).toEqual(["begin", "update"]);
  });

  it("`thresholdPx: 0` promotes on pointerdown itself (SS10 pencil Paint)", () => {
    const paint = recordingHandler({ id: "test.paint", thresholdPx: 0 });
    const h = harness({ handler: paint });
    h.down(150, 50);
    expect(h.engine.phase).toBe("dragging");
    expect(paint.log).toEqual(["begin", "update"]);
  });

  it("honours a handler's own larger threshold", () => {
    const lazy = recordingHandler({ thresholdPx: 20 });
    const h = harness({ handler: lazy });
    h.down(150, 50);
    h.move(165, 50);
    expect(h.engine.phase).toBe("pending");
    h.move(175, 50);
    expect(h.engine.phase).toBe("dragging");
  });
});

describe("gesture engine — previews are ghosts, never document writes (SS9)", () => {
  it("update returns the new preview and the engine stores it", () => {
    const h = harness();
    h.down(150, 50);
    h.move(200, 50);
    h.move(260, 82); // +110 px = 2200 ticks, +32 px = 2 rows
    const preview = h.engine.preview as Preview;
    expect(preview.deltaTicks).toBe(2200);
    expect(preview.deltaRows).toBe(2);
  });

  it("dispatches NOTHING while the drag is moving", () => {
    const h = harness();
    h.down(150, 50);
    for (let x = 155; x < 400; x += 5) h.move(x, 50);
    expect(h.dispatched).toEqual([]);
  });

  it("invalidates the OVERLAY on every drag frame and on hover changes", () => {
    const h = harness();
    const before = h.overlayInvalidations;
    h.down(150, 50);
    h.move(200, 50);
    h.move(210, 50);
    h.move(220, 50);
    expect(h.overlayInvalidations).toBeGreaterThanOrEqual(before + 3);
  });

  it("drawActivePreview delegates to the ACTIVE handler only", () => {
    const drawPreview = vi.fn();
    const h = harness({ handler: recordingHandler({ drawPreview }) });
    const frame = { ctx: {}, viewport: h.viewport, widthPx: 800, heightPx: 400, dpr: 2, time: 0 };
    h.engine.drawActivePreview(frame as never);
    expect(drawPreview).not.toHaveBeenCalled(); // idle: nothing to draw
    h.down(150, 50);
    h.move(200, 50);
    h.engine.drawActivePreview(frame as never);
    expect(drawPreview).toHaveBeenCalledTimes(1);
    expect(drawPreview.mock.calls[0]?.[1]).toEqual(h.engine.preview);
  });
});

describe("gesture engine — exactly one command on release (SS3/SS13)", () => {
  it("commits once and dispatches once for a whole drag", () => {
    const h = harness();
    h.down(150, 50);
    for (let x = 155; x <= 300; x += 5) h.move(x, 50);
    h.up(300, 50);
    expect(h.handler.log.filter((e) => e === "commit")).toHaveLength(1);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.label).toBe("Move Notes");
  });

  it("refreshes the preview at the release point before committing", () => {
    const h = harness();
    h.down(150, 50);
    h.move(200, 50);
    h.up(400, 50); // a big last-instant jump, never seen by `update` before
    expect(h.handler.lastCommit?.preview.deltaTicks).toBe(5000);
    expect(h.handler.lastCommit?.deltaTicks).toBe(5000);
  });

  it("dispatches nothing when commit returns null (marquee: not undoable)", () => {
    const marquee = recordingHandler({ id: "test.marquee" });
    marquee.commandOnCommit = null;
    const h = harness({ handler: marquee });
    h.down(150, 50);
    h.move(300, 50);
    h.up(300, 50);
    expect(marquee.log).toContain("commit");
    expect(h.dispatched).toEqual([]);
  });

  it("returns to idle with no preview after a commit", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.up(300, 50);
    expect(h.engine.phase).toBe("idle");
    expect(h.engine.preview).toBeNull();
    expect(h.engine.activeHandlerId).toBeNull();
  });

  it("re-hovers at the release point so the cursor is correct immediately", () => {
    const h = harness();
    h.down(150, 50);
    h.move(400, 50);
    h.up(400, 50);
    expect(h.engine.hover?.kind).toBe("empty");
    expect(h.engine.cursor).toBe("crosshair");
  });
});

describe("gesture engine — click (released under the threshold)", () => {
  it("calls `click`, not `begin`/`commit`", () => {
    const h = harness();
    h.down(150, 50);
    h.move(151, 51);
    h.up(151, 51);
    expect(h.handler.log).toEqual(["click"]);
  });

  it("passes the click count and the live modifiers (Shift adds, Ctrl toggles)", () => {
    const h = harness();
    const mods = modifiers({ shift: true });
    h.down(150, 50, { modifiers: mods, clickCount: 2 });
    h.up(150, 50, { modifiers: mods, clickCount: 2 });
    expect(h.handler.lastClick).toEqual({ clickCount: 2, modifiers: mods });
  });

  it("dispatches the click's command when it returns one (dbl-click create)", () => {
    const h = harness();
    h.handler.commandOnClick = command("Add Note");
    h.down(150, 50, { clickCount: 2 });
    h.up(150, 50, { clickCount: 2 });
    expect(h.dispatched.map((c) => c.label)).toEqual(["Add Note"]);
  });

  it("a handler with no `click` simply produces no command", () => {
    const noClick = recordingHandler();
    delete (noClick as { click?: unknown }).click;
    const h = harness({ handler: noClick });
    h.down(150, 50);
    h.up(150, 50);
    expect(h.dispatched).toEqual([]);
    expect(h.engine.phase).toBe("idle");
  });
});

describe("gesture engine — Esc aborts with ZERO document traffic (SS9)", () => {
  it("reverts a live drag: cancel is called, nothing is dispatched", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.engine.cancel();
    expect(h.handler.log).toEqual(["begin", "update", "cancel"]);
    expect(h.dispatched).toEqual([]);
    expect(h.engine.phase).toBe("idle");
    expect(h.engine.preview).toBeNull();
  });

  it("hands the LAST preview to cancel so the handler can undo its ghosts", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.engine.cancel();
    expect(h.handler.cancelledWith?.deltaTicks).toBe(3000);
  });

  it("keyDown('Escape') during a drag cancels and is consumed", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    expect(h.engine.keyDown({ key: "Escape", modifiers: modifiers() })).toBe(true);
    expect(h.handler.log).toContain("cancel");
    expect(h.dispatched).toEqual([]);
  });

  it("Escape in `idle` is NOT consumed — the editor clears selection (SS10)", () => {
    const h = harness();
    expect(h.engine.keyDown({ key: "Escape", modifiers: modifiers() })).toBe(false);
  });

  it("cancels a `pending` gesture without calling begin/cancel/click", () => {
    const h = harness();
    h.down(150, 50);
    h.engine.cancel();
    expect(h.handler.log).toEqual([]);
    expect(h.engine.phase).toBe("idle");
    expect(h.dispatched).toEqual([]);
  });

  it("a release AFTER a cancel commits nothing (the FSM is already idle)", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.engine.cancel();
    h.up(300, 50);
    expect(h.dispatched).toEqual([]);
    expect(h.handler.log.filter((e) => e === "commit")).toHaveLength(0);
  });

  it("pointercancel behaves exactly like Esc", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.engine.pointerCancel({
      pointerId: 1,
      point: h.point(300, 50),
      button: 0,
      buttons: 0,
      modifiers: modifiers(),
    });
    expect(h.handler.log).toContain("cancel");
    expect(h.dispatched).toEqual([]);
  });
});

describe("gesture engine — pointer identity (capture semantics)", () => {
  it("ignores moves and releases from a different pointer", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.move(600, 50, { pointerId: 2 });
    expect((h.engine.preview as Preview).deltaTicks).toBe(3000);
    h.up(600, 50, { pointerId: 2 });
    expect(h.engine.phase).toBe("dragging");
    expect(h.dispatched).toEqual([]);
  });

  it("ignores a second pointerdown while a gesture is live", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.down(150, 50, { pointerId: 5 });
    expect(h.engine.activeHandlerId).toBe("test.move");
    expect(h.handler.log.filter((e) => e === "begin")).toHaveLength(1);
  });
});

describe("gesture engine — handler and tester ordering", () => {
  it("the highest-priority hit-tester that returns non-null wins", () => {
    const h = harness({
      hitTesters: [
        { id: "low", priority: 0, hitTest: () => ({ kind: "empty" }) },
        { id: "high", priority: 5, hitTest: () => ({ kind: "edge", cursor: "ew-resize" }) },
      ],
    });
    h.move(10, 10);
    expect(h.engine.hover?.kind).toBe("edge");
  });

  it("the first handler to claim owns the gesture, by priority then registration", () => {
    const h = harness();
    const winner = recordingHandler({ id: "hi", priority: 9 });
    h.engine.registerDragHandler(winner);
    h.down(150, 50);
    expect(h.engine.activeHandlerId).toBe("hi");
  });

  it("unregistering removes a handler from the running order", () => {
    const h = harness();
    const winner = recordingHandler({ id: "hi", priority: 9 });
    const unsub = h.engine.registerDragHandler(winner);
    unsub();
    h.down(150, 50);
    expect(h.engine.activeHandlerId).toBe("test.move");
  });

  it("claim sees the hit, the modifiers and the click count (Alt+body = DragDup)", () => {
    const seen: GestureStart<TestHit>[] = [];
    const h = harness({
      handler: recordingHandler({
        claim: (start) => {
          seen.push(start);
          return start.modifiers.alt;
        },
      }),
    });
    h.down(150, 50);
    expect(h.engine.phase).toBe("idle");
    h.down(150, 50, { modifiers: modifiers({ alt: true }) });
    expect(h.engine.phase).toBe("pending");
    expect(seen[1]?.hit.kind).toBe("note");
    expect(seen[1]?.modifiers.alt).toBe(true);
  });
});

describe("gesture engine — live modifiers and grid access during a drag", () => {
  it("update sees the modifiers of the CURRENT frame, not of pointerdown", () => {
    const seen: Modifiers[] = [];
    const h = harness({
      handler: recordingHandler({
        update: (u) => {
          seen.push(u.modifiers);
          return u.preview;
        },
      }),
    });
    h.down(150, 50);
    h.move(300, 50);
    h.move(320, 50, { modifiers: modifiers({ alt: true }) });
    expect(seen[0]?.alt).toBe(false);
    expect(seen[1]?.alt).toBe(true);
  });

  it("hands the viewport and grid to begin/update/commit", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.up(300, 50);
    expect(h.handler.lastCommit?.viewport).toBe(h.viewport);
    expect(h.handler.lastCommit?.grid).toBe(h.grid);
    expect(h.handler.lastCommit?.start.grid).toBe(h.grid);
  });

  it("deltaTicks is RAW (unsnapped); the handler snaps through the grid", () => {
    const h = harness();
    h.grid.setSettings({ mode: "fixed", denominator: 4 }); // 960-tick grid
    h.down(150, 50);
    h.move(200, 50); // 50 px = 1000 raw ticks
    expect(h.handler.log).toContain("update");
    // The handler in this fixture snaps: 1000 -> 960.
    expect((h.engine.preview as Preview).deltaTicks).toBe(960);
  });
});

// --- wheel ------------------------------------------------------------------

describe("gesture engine — uniform wheel bindings (SS9)", () => {
  const wheelAt = (h: Harness, over: Partial<Parameters<Harness["engine"]["wheel"]>[0]>) =>
    h.engine.wheel({
      deltaX: 0,
      deltaY: 0,
      point: h.point(400, 200),
      modifiers: modifiers(),
      ...over,
    });

  it("wheel = VERTICAL scroll", () => {
    const h = harness();
    const before = h.viewport.scrollRows;
    expect(wheelAt(h, { deltaY: 64 })).toBe(true);
    expect(h.viewport.scrollRows).toBe(before + 4); // 64 px / 16 px per row
    expect(h.viewport.scrollTicks).toBe(0);
  });

  it("Shift+wheel = HORIZONTAL scroll", () => {
    const h = harness();
    wheelAt(h, { deltaY: 50, modifiers: modifiers({ shift: true }) });
    expect(h.viewport.scrollTicks).toBe(1000); // 50 px / 0.05 px per tick
    expect(h.viewport.scrollRows).toBe(0);
  });

  it("Shift+wheel falls back to deltaX when the platform already swapped axes", () => {
    const h = harness();
    wheelAt(h, { deltaX: 50, deltaY: 0, modifiers: modifiers({ shift: true }) });
    expect(h.viewport.scrollTicks).toBe(1000);
  });

  it("a trackpad's horizontal component pans without Shift", () => {
    const h = harness();
    wheelAt(h, { deltaX: 20, deltaY: 0 });
    expect(h.viewport.scrollTicks).toBe(400);
  });

  it("Ctrl+wheel = zoom-to-cursor, keeping the tick under the pointer fixed", () => {
    const h = harness();
    h.viewport.setScroll(20_000, 0);
    const anchor = h.viewport.tAt(400);
    wheelAt(h, { deltaY: -200, modifiers: modifiers({ ctrl: true }) });
    expect(h.viewport.pxPerTick).toBeGreaterThan(0.05);
    expect(Math.abs(h.viewport.xOf(anchor) - 400)).toBeLessThanOrEqual(h.viewport.pxPerTick);
  });

  it("Cmd+wheel zooms too (SS9's `Ctrl/Cmd`)", () => {
    const h = harness();
    wheelAt(h, { deltaY: -200, modifiers: modifiers({ meta: true, primary: true }) });
    expect(h.viewport.pxPerTick).toBeGreaterThan(0.05);
  });

  it("a trackpad pinch zooms even with no modifier flags set", () => {
    const h = harness();
    wheelAt(h, { deltaY: -200, pinch: true });
    expect(h.viewport.pxPerTick).toBeGreaterThan(0.05);
  });

  it("zoom in then out by the same notch returns to the same zoom", () => {
    const h = harness();
    wheelAt(h, { deltaY: -120, modifiers: modifiers({ ctrl: true }) });
    wheelAt(h, { deltaY: 120, modifiers: modifiers({ ctrl: true }) });
    expect(h.viewport.pxPerTick).toBeCloseTo(0.05, 12);
  });

  it("Ctrl+Shift+wheel zooms the ROW axis", () => {
    const h = harness();
    wheelAt(h, { deltaY: -200, modifiers: modifiers({ ctrl: true, shift: true }) });
    expect(h.viewport.pxPerRow).toBeGreaterThan(16);
    expect(h.viewport.pxPerTick).toBe(0.05);
  });

  it("re-derives the live preview when the viewport moves under a drag", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    expect((h.engine.preview as Preview).deltaTicks).toBe(3000);
    // Zooming in doubles px-per-tick: the same 150 px of travel is now half
    // the musical distance, and the ghost must follow the pointer, not the tick.
    wheelAt(h, { deltaY: -1000, modifiers: modifiers({ ctrl: true }) });
    const preview = h.engine.preview as Preview;
    expect(preview.deltaTicks).toBeLessThan(3000);
    expect(preview.deltaTicks).toBeGreaterThan(0);
    expect(h.dispatched).toEqual([]);
  });
});

// --- keyboard ---------------------------------------------------------------

describe("gesture engine — key bindings are a first-class client (SS10)", () => {
  it("dispatches a binding's command exactly like a drag commit", () => {
    const del = command("Delete Notes");
    const binding: KeyBinding = {
      id: "delete",
      handle: (input) => (input.key === "Delete" ? { command: del } : null),
    };
    const h = harness({ keyBindings: [binding] });
    expect(h.engine.keyDown({ key: "Delete", modifiers: modifiers() })).toBe(true);
    expect(h.dispatched).toEqual([del]);
  });

  it("passes the key on when a binding returns null", () => {
    const binding: KeyBinding = { id: "none", handle: () => null };
    const h = harness({ keyBindings: [binding] });
    expect(h.engine.keyDown({ key: "q", modifiers: modifiers() })).toBe(false);
    expect(h.dispatched).toEqual([]);
  });

  it("honours preventDefault: false so the browser still sees the key", () => {
    const binding: KeyBinding = {
      id: "passthrough",
      handle: () => ({ preventDefault: false }),
    };
    const h = harness({ keyBindings: [binding] });
    expect(h.engine.keyDown({ key: "a", modifiers: modifiers() })).toBe(false);
  });

  it("runs bindings by priority and stops at the first non-null outcome", () => {
    const order: string[] = [];
    const low: KeyBinding = {
      id: "low",
      priority: 0,
      handle: () => {
        order.push("low");
        return {};
      },
    };
    const high: KeyBinding = {
      id: "high",
      priority: 5,
      handle: () => {
        order.push("high");
        return {};
      },
    };
    const h = harness({ keyBindings: [low, high] });
    h.engine.keyDown({ key: "x", modifiers: modifiers() });
    expect(order).toEqual(["high"]);
  });

  it("a binding registered later can be unregistered", () => {
    const h = harness();
    const unsub = h.engine.registerKeyBinding({
      id: "temp",
      handle: () => ({ command: command("Nope") }),
    });
    unsub();
    expect(h.engine.keyDown({ key: "z", modifiers: modifiers() })).toBe(false);
  });
});

describe("gesture engine — onChange and dispose", () => {
  it("notifies on phase, hover and preview changes", () => {
    const h = harness();
    const seen = vi.fn();
    h.engine.onChange(seen);
    h.move(150, 50); // hover
    h.down(150, 50); // pending
    h.move(300, 50); // dragging + preview
    h.up(300, 50); // commit
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("dispose cancels a live drag without dispatching, then goes inert", () => {
    const h = harness();
    h.down(150, 50);
    h.move(300, 50);
    h.engine.dispose();
    expect(h.handler.log).toContain("cancel");
    expect(h.dispatched).toEqual([]);
    h.down(150, 50);
    expect(h.engine.phase).toBe("idle");
    expect(h.engine.wheel({ deltaX: 0, deltaY: 10, point: h.point(0, 0), modifiers: modifiers() })).toBe(false);
  });
});
