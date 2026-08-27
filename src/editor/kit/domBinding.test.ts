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
  /** `ClickInfo.clickCount` as the handler received it, per release. */
  const clicks: number[] = [];

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
    click: (_start, info) => {
      clicks.push(info.clickCount);
      return null;
    },
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

  return { element, viewport, engine, dispatched, seen, clicks };
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

  // SS10's `Pending` row gives a single click exactly one meaning. A drag that
  // ends near where it started is still a DRAG, so the click that follows it
  // must count as the first of a new streak — otherwise the double-click verb
  // ("dbl-click empty: create ...") fires on a plain click and writes an
  // undoable edit the user never asked for.
  it("a completed drag ends the multi-click streak", () => {
    ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("pointermove", { clientX: 400, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("pointerup", { clientX: 400, clientY: 60, buttons: 0 }));
    expect(ctx.dispatched.map((c) => c.label)).toEqual(["Move"]);

    ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
    ctx.element.dispatchEvent(pointerEvent("pointerup", { clientX: 150, clientY: 60, buttons: 0 }));
    expect(ctx.clicks).toEqual([1]);
  });

  it("still counts a real double click (the streak is only broken by a drag)", () => {
    for (let i = 0; i < 2; i += 1) {
      ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
      ctx.element.dispatchEvent(pointerEvent("pointerup", { clientX: 150, clientY: 60, buttons: 0 }));
    }
    expect(ctx.clicks).toEqual([1, 2]);
  });

  // The engine swallows every key but `Esc` while a gesture is live; that is
  // only true if the event also stops here. The app shell binds undo/redo on
  // `window` (SS13), and a keydown that merely had `preventDefault()` called
  // still bubbles there — undoing the document mid-drag.
  it("does not let a consumed key escape to a window-level shortcut", () => {
    const atWindow: string[] = [];
    const spy = (e: Event) => atWindow.push((e as KeyboardEvent).key);
    window.addEventListener("keydown", spy);
    try {
      ctx.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
      expect(atWindow).toEqual([]);

      // Mid-drag, EVERY key is consumed — including the shell's undo.
      ctx.element.dispatchEvent(pointerEvent("pointerdown", { clientX: 150, clientY: 60 }));
      ctx.element.dispatchEvent(pointerEvent("pointermove", { clientX: 400, clientY: 60 }));
      expect(ctx.engine.phase).toBe("dragging");
      ctx.element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(atWindow).toEqual([]);
      expect(ctx.engine.phase).toBe("dragging");

      // An UNhandled key still reaches the window (idle, no binding for it).
      ctx.element.dispatchEvent(pointerEvent("pointerup", { clientX: 400, clientY: 60, buttons: 0 }));
      ctx.element.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true }));
      expect(atWindow).toEqual(["F5"]);
    } finally {
      window.removeEventListener("keydown", spy);
    }
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
