// SS5 conformance, at the DOM boundary.
//
// gesture.test.ts proves the value math headlessly; this file proves the one
// piece that only exists once the control is mounted in a browser-shaped DOM:
// that real events reach that math the way the SS5 gesture table says they
// should. It is deliberately event-level (`dispatchEvent`, not helpers) —
// the bugs it exists to catch (a passive `wheel` listener, a wheel direction
// read off the wrong axis) live precisely in how the listener is registered.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { p } from "../../params/descriptors";
import { deviceParamId } from "../../params/paramIds";
import { createParamRegistry, type AppParamRegistry, type ParamCommit } from "../../params/registry";
import type { RegistryParamHandle } from "../../params/handle";
import { Knob } from "./Knob";
import { WHEEL_STEP, FINE_FACTOR } from "./gesture";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const AMOUNT = deviceParamId("t1", "d1", "amount");
const amountDesc = () => ({
  ...p.percent("amount", "Amount", { min: 0, max: 100, default: 50 }),
  id: AMOUNT,
});

let container: HTMLDivElement;
let root: Root;
let registry: AppParamRegistry;
let handle: RegistryParamHandle;
let commits: ParamCommit[];
let frames: Array<() => void>;

function flushFrames(): void {
  act(() => {
    const pending = frames.splice(0, frames.length);
    for (const cb of pending) cb();
  });
}

function mount(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function paramState(): string | null {
  return control().getAttribute("data-param-state");
}

function control(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="ctl"]');
  if (el === null) throw new Error("control not mounted");
  return el;
}

/** jsdom has no pointer capture; the shell calls it on every drag start. */
function pointer(type: string, init: MouseEventInit = {}): void {
  const el = control();
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => {
    el.dispatchEvent(event);
  });
}

function wheel(init: WheelEventInit): boolean {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  act(() => {
    control().dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** React tracks the input's last value on the node; assigning `.value`
 *  directly leaves that tracker in sync and the change event is swallowed. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(type: "keydown", init: KeyboardEventInit, target: EventTarget = control()): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  frames = [];
  registry = createParamRegistry({
    now: () => 0,
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
  });
  handle = registry.register(amountDesc());
  commits = [];
  registry.onCommit((c) => commits.push(c));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mount(<Knob handle={handle} testId="ctl" />);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  registry.dispose();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("wheel (SS5: 1% of sweep, Shift = 0.1%, consumed while hovering)", () => {
  it("consumes the event so the page underneath does not scroll", () => {
    // React 19 registers `wheel` on its root container as PASSIVE, so a
    // synthetic `onWheel` calling preventDefault() is ignored and the strip
    // scrolls out from under the pointer mid-adjustment. The listener has to
    // be native and `{ passive: false }` — this assertion is that contract.
    expect(wheel({ deltaY: -100 })).toBe(true);
  });

  it("steps up on a wheel-away notch and down on a wheel-toward notch", () => {
    wheel({ deltaY: -100 });
    expect(handle.live()).toBeCloseTo(50 + 100 * WHEEL_STEP, 10);
    wheel({ deltaY: 100 });
    expect(handle.live()).toBeCloseTo(50, 10);
    expect(commits).toHaveLength(2); // one undo entry per notch
  });

  it("Shift+wheel is fine, in the direction the platform reports", () => {
    wheel({ deltaY: -100, shiftKey: true });
    expect(handle.live()).toBeCloseTo(50 + 100 * WHEEL_STEP * FINE_FACTOR, 10);
  });

  it("falls back to deltaX when the platform swapped the axes", () => {
    // Shift+wheel and trackpad side-swipes arrive as deltaX with deltaY === 0;
    // reading deltaY alone made every one of them a DOWNWARD notch.
    wheel({ deltaX: -100, deltaY: 0, shiftKey: true });
    expect(handle.live()).toBeCloseTo(50 + 100 * WHEEL_STEP * FINE_FACTOR, 10);
    wheel({ deltaX: 100, deltaY: 0, shiftKey: true });
    expect(handle.live()).toBeCloseTo(50, 10);
  });

  it("ignores a zero delta instead of treating it as 'down'", () => {
    expect(wheel({ deltaX: 0, deltaY: 0 })).toBe(true); // still consumed
    expect(handle.live()).toBe(50);
    expect(commits).toEqual([]); // and the document stays clean
  });
});

describe("pointer + keyboard (SS5 gesture table)", () => {
  it("Alt+click resets to the default in one commit", () => {
    handle.setLive(80, "user");
    handle.commit();
    commits.length = 0;

    pointer("pointerdown", { altKey: true, clientY: 100 });
    expect(handle.live()).toBe(50);
    expect(commits).toHaveLength(1);
  });

  it("drags relative to the press point and commits once on release", () => {
    pointer("pointerdown", { clientY: 200 });
    pointer("pointermove", { clientY: 185 }); // 15 px up of a 150 px sweep
    expect(handle.live()).toBeCloseTo(60, 10);
    expect(commits).toEqual([]);
    pointer("pointerup", { clientY: 185 });
    expect(commits).toHaveLength(1);
    expect(handle.base()).toBeCloseTo(60, 10);
  });

  it("Esc mid-drag reverts to the pre-drag value with no undo entry", () => {
    pointer("pointerdown", { clientY: 200 });
    pointer("pointermove", { clientY: 170 });
    expect(handle.live()).toBeCloseTo(70, 10);

    key("keydown", { key: "Escape" }, window);
    expect(handle.live()).toBe(50);
    expect(commits).toEqual([]);

    // The drag is over: further movement must not keep steering the param.
    pointer("pointermove", { clientY: 100 });
    expect(handle.live()).toBe(50);
  });

  it("Enter opens numeric entry and commits what fromText parses", () => {
    key("keydown", { key: "Enter" });
    const input = container.querySelector<HTMLInputElement>('[data-testid="ctl-entry"]');
    expect(input).not.toBeNull();

    act(() => {
      if (input !== null) setInputValue(input, "75");
    });
    key("keydown", { key: "Enter" }, input ?? window);

    expect(handle.base()).toBeCloseTo(75, 10);
    expect(commits).toHaveLength(1);
    expect(container.querySelector('[data-testid="ctl-entry"]')).toBeNull();
  });

  it("arrow keys step and PageUp pages", () => {
    key("keydown", { key: "ArrowUp" });
    expect(handle.live()).toBeCloseTo(51, 10);
    key("keydown", { key: "ArrowDown", shiftKey: true });
    expect(handle.live()).toBeCloseTo(50.9, 10);
    key("keydown", { key: "PageUp" });
    expect(handle.live()).toBeCloseTo(60.9, 10);
  });
});

describe("automation state is visible on the control (SS5 inventory)", () => {
  it("renders the SS4 state and dims + pulses the arc when overridden", () => {
    expect(paramState()).toBe("free");

    act(() => {
      handle.setAutomated(true);
    });
    flushFrames();
    expect(paramState()).toBe("automated");
    expect(container.querySelector('[data-param-arc="overridden"]')).toBeNull();

    // Touching an automated control during playback suspends its lane — the
    // ONLY per-param signal of that is what this control draws.
    pointer("pointerdown", { clientY: 200 });
    pointer("pointermove", { clientY: 190 });
    pointer("pointerup", { clientY: 190 });
    flushFrames();

    expect(handle.state).toBe("overridden");
    expect(paramState()).toBe("overridden");
    const arc = container.querySelector('[data-param-arc="overridden"]');
    expect(arc).not.toBeNull();
    expect(arc?.querySelector("animate")).not.toBeNull();

    act(() => {
      registry.reenableAutomation();
    });
    flushFrames();
    expect(paramState()).toBe("automated");
    expect(container.querySelector('[data-param-arc="overridden"]')).toBeNull();
  });

  it("repaints a state flip even though the value never moved", () => {
    // The trap: `setValue(sameNumber)` bails out of re-rendering, so a hook
    // that only tracked the value would draw a stale state forever.
    const before = paramState();
    act(() => {
      handle.setAutomated(true);
    });
    flushFrames();
    expect(before).toBe("free");
    expect(paramState()).toBe("automated");
    expect(handle.live()).toBe(50);
  });
});

describe("right-click menu (SS5)", () => {
  it("offers Type value / Reset / Copy param path, and the lane row when wired", () => {
    act(() => {
      control().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent);
    expect(labels).toEqual(["Type value…", "Reset", "Copy param path"]);

    const onShowAutomation = vi.fn();
    mount(<Knob handle={handle} testId="ctl" onShowAutomation={onShowAutomation} />);
    act(() => {
      control().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const withLane = [...container.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent);
    expect(withLane).toContain("Show automation lane");
  });
});
