// The DOM half of the gesture engine: the thin adapter that turns real events
// into the plain objects the FSM speaks (SS15). jsdom ships no `PointerEvent`
// and no pointer capture, which is precisely the environment the adapter has
// to survive — a lost capture must degrade to `pointercancel`, never to a
// half-applied edit.

import { beforeEach, describe, expect, it } from "vitest";
import type { Command } from "../../types/commands";
import type { DragHandler, HitTarget, HitTester } from "../../types/gesture";
import { createGrid } from "./grid";
import { createKitGestureEngine } from "./gestureEngine";
import { setApplePlatform } from "./points";
import { createViewport } from "./viewport";

interface Hit extends HitTarget {
  readonly kind: "any";
}

/** jsdom has no PointerEvent; a MouseEvent plus the pointer fields is enough. */
function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; pointerId?: number; buttons?: number; detail?: number },
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    buttons: init.buttons ?? 1,
    detail: init.detail ?? 1,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event as PointerEvent;
}

function setup() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  // jsdom lays nothing out: pin the rect so client -> content math is real.
  element.getBoundingClientRect = () =>
    ({ left: 50, top: 20, width: 800, height: 400, right: 850, bottom: 420, x: 50, y: 20, toJSON: () => ({}) }) as DOMRect;

  const viewport = createViewport({ pxPerTick: 0.05, pxPerRow: 16, widthPx: 800, heightPx: 400 });
  const grid = createGrid({ viewport, settings: { mode: "off" } });
  const dispatched: Command[] = [];
  const command: Command = { label: "Move", run: () => undefined };
  const seen: { xPx: number; tick: number }[] = [];

  const handler: DragHandler<Hit, number> = {
    id: "d",
    claim: () => true,
    begin: () => 0,
    update: (u) => {
      seen.push({ xPx: u.point.xPx, tick: u.point.tick });
      return u.deltaTicks;
    },
    commit: () => command,
    cancel: () => undefined,
  };
  const tester: HitTester<Hit> = { id: "all", hitTest: () => ({ kind: "any", cursor: "grab" }) };

  const engine = createKitGestureEngine<Hit>({
    element,
    viewport,
    grid,
    dispatch: (c) => dispatched.push(c),
    hitTesters: [tester],
    dragHandlers: [handler as DragHandler<Hit, unknown>],
    keyBindings: [
      {
        id: "delete",
        handle: (input) =>
          input.key === "Delete" ? { command: { label: "Delete", run: () => undefined } } : null,
      },
    ],
  });

  return { element, viewport, engine, dispatched, seen };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  document.body.innerHTML = "";
  setApplePlatform(false);
  ctx = setup();
});

describe("gesture engine — DOM binding", () => {
  it("subtracts the element's rect, so coordinates are content-relative", () => {
    ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("pointermove", { clientX: 250, clientY: 60 }));
    expect(ctx.seen[0]).toEqual({ xPx: 200, tick: 4000 }); // 250 - 50
  });

  it("runs a whole click-drag-release through real events and dispatches once", () => {
    ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
    for (let x = 160; x <= 300; x += 20) {
      ctx.element.dispatchEvent(pointerEvent("pointermove", { clientX: x, clientY: 60 }));
    }
    ctx.element.dispatchEvent(pointerEvent("pointerup", { clientX: 300, clientY: 60, buttons: 0 }));
    expect(ctx.dispatched.map((c) => c.label)).toEqual(["Move"]);
    expect(ctx.engine.phase).toBe("idle");
  });

  it("survives an environment with no pointer capture at all (jsdom)", () => {
    expect(typeof (ctx.element as unknown as { setPointerCapture?: unknown }).setPointerCapture)
      .toBe("undefined");
    expect(() => {
      ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
      ctx.element.dispatchEvent(pointerEvent("pointerup", { clientX: 150, clientY: 60, buttons: 0 }));
    }).not.toThrow();
  });

  it("treats `lostpointercapture` as a cancel — never a half-applied edit", () => {
    ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("lostpointercapture", { clientX: 300, clientY: 60 }));
    expect(ctx.engine.phase).toBe("idle");
    expect(ctx.dispatched).toEqual([]);
  });

  it("mirrors the cursor onto the element while hovering", () => {
    ctx.element.dispatchEvent(pointerEvent("pointermove", { clientX: 150, clientY: 60, buttons: 0 }));
    expect(ctx.element.style.cursor).toBe("grab");
  });

  it("consumes the wheel so the page never scrolls under the editor", () => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 32,
      clientX: 150,
      clientY: 60,
    });
    ctx.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(ctx.viewport.scrollRows).toBe(2);
  });

  it("normalizes line-mode wheel deltas into pixels", () => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 2,
      deltaMode: 1, // DOM_DELTA_LINE
      clientX: 150,
      clientY: 60,
    });
    ctx.element.dispatchEvent(event);
    expect(ctx.viewport.scrollRows).toBe(2); // 2 lines * 16 px = 32 px = 2 rows
  });

  it("consumes a handled key and preventDefaults it", () => {
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    ctx.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(ctx.dispatched.map((c) => c.label)).toEqual(["Delete"]);
  });

  it("leaves an unhandled key to the browser", () => {
    const event = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    ctx.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("suppresses the context menu (right-click is an editor verb)", () => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    ctx.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents the pointerdown default, or the browser cancels every drag", () => {
    // Regression guard. Chrome answers an un-prevented `pointerdown` on the
    // editor by starting its OWN gesture (text selection / native drag): it
    // takes the pointer and fires `pointercancel` right after this handler
    // returns, so no `pointermove` or `pointerup` ever arrives and no drag
    // can reach `commit`. jsdom cannot reproduce that behavior, so this test
    // pins the one thing that prevents it. `setPointerCapture` and
    // `touch-action: none` do NOT substitute for it.
    const event = pointerEvent("pointerdown", { clientX: 150, clientY: 60 });
    ctx.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("still focuses the editor on pointerdown, despite preventDefault", () => {
    // `preventDefault` suppresses the browser's own focus-on-mousedown, so
    // the binding has to take focus explicitly or the key bindings go dead.
    let focused = 0;
    ctx.element.focus = () => {
      focused += 1;
    };
    ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
    expect(focused).toBe(1);
  });

  it("dispose detaches every listener", () => {
    ctx.engine.dispose();
    ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("pointerup", { clientX: 300, clientY: 60, buttons: 0 }));
    expect(ctx.dispatched).toEqual([]);
  });
});
