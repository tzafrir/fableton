import { afterEach, describe, expect, it } from "vitest";
import { createViewport } from "./viewport";
import {
  MULTI_CLICK_MS,
  MULTI_CLICK_SLOP_PX,
  NO_MODIFIERS,
  createClickCounter,
  editorPointOf,
  keyInputOf,
  modifiers,
  modifiersOf,
  setApplePlatform,
} from "./points";

afterEach(() => {
  setApplePlatform(null);
});

describe("modifier normalization", () => {
  it("`primary` is Ctrl off Apple platforms and Cmd on them (SS10 Cmd/Ctrl)", () => {
    const event = { shiftKey: false, altKey: false, ctrlKey: true, metaKey: false };
    setApplePlatform(false);
    expect(modifiersOf(event).primary).toBe(true);
    setApplePlatform(true);
    expect(modifiersOf(event).primary).toBe(false);
    expect(modifiersOf({ ...event, ctrlKey: false, metaKey: true }).primary).toBe(true);
  });

  it("carries every flag through verbatim", () => {
    setApplePlatform(false);
    expect(
      modifiersOf({ shiftKey: true, altKey: true, ctrlKey: false, metaKey: true }),
    ).toEqual({ shift: true, alt: true, ctrl: false, meta: true, primary: false });
  });

  it("the test helper derives `primary` unless it is given explicitly", () => {
    setApplePlatform(false);
    expect(modifiers({ ctrl: true }).primary).toBe(true);
    expect(modifiers({ ctrl: true, primary: false }).primary).toBe(false);
    expect(modifiers()).toEqual(NO_MODIFIERS);
  });
});

describe("editorPointOf", () => {
  it("carries all three coordinate systems, with an integer tick", () => {
    const v = createViewport({ pxPerTick: 0.05, pxPerRow: 16, scrollTicks: 960 });
    const p = editorPointOf(v, 40, 24);
    expect(p.xPx).toBe(40);
    expect(p.yPx).toBe(24);
    expect(p.tick).toBe(960 + 800);
    expect(Number.isInteger(p.tick)).toBe(true);
    expect(p.row).toBe(1.5);
  });
});

describe("keyInputOf", () => {
  it("keeps `key` and `code` so layout-stable bindings are possible", () => {
    setApplePlatform(false);
    const input = keyInputOf(
      new KeyboardEvent("keydown", { key: "0", code: "Digit0", ctrlKey: true }),
    );
    expect(input.key).toBe("0");
    expect(input.code).toBe("Digit0");
    expect(input.modifiers.primary).toBe(true);
  });
});

describe("createClickCounter", () => {
  // The regression this exists for: `PointerEvent.detail` is fixed at 0 by
  // the Pointer Events spec, so click count CANNOT be read off the event. It
  // has to be derived from pointerdown timing and position, and these tests
  // drive that derivation directly rather than through a hand-built
  // `PointerInput` — which is exactly the blind spot that let the original
  // `event.detail` bug pass 1083 unit tests.
  function down(
    over: Partial<{ clientX: number; clientY: number; button: number; pointerType: string }> = {},
  ): PointerEvent {
    return {
      clientX: 100,
      clientY: 100,
      button: 0,
      pointerType: "mouse",
      detail: 0,
      ...over,
    } as PointerEvent;
  }

  /** A counter with a hand-cranked clock, so no test depends on wall time. */
  function counterAt(): { tick: (ms: number) => void; counter: ReturnType<typeof createClickCounter> } {
    let t = 1000;
    const counter = createClickCounter(() => t);
    return { tick: (ms) => { t += ms; }, counter };
  }

  it("counts a fast, stationary repeat as 2 then 3", () => {
    const { tick, counter } = counterAt();
    expect(counter.register(down())).toBe(1);
    tick(80);
    expect(counter.register(down())).toBe(2);
    tick(80);
    expect(counter.register(down())).toBe(3);
  });

  it("never reads `detail` — a `detail: 0` event still reaches 2", () => {
    const { tick, counter } = counterAt();
    counter.register(down());
    tick(50);
    // Exactly what a real browser sends on `pointerdown`.
    expect(counter.register({ ...down(), detail: 0 } as PointerEvent)).toBe(2);
  });

  it("restarts the streak once the downs are too far apart in time", () => {
    const { tick, counter } = counterAt();
    counter.register(down());
    tick(MULTI_CLICK_MS + 1);
    expect(counter.register(down())).toBe(1);
  });

  it("restarts the streak once the downs are too far apart in space", () => {
    const { tick, counter } = counterAt();
    counter.register(down());
    tick(20);
    expect(counter.register(down({ clientX: 100 + MULTI_CLICK_SLOP_PX + 1 }))).toBe(1);
  });

  it("keeps the streak inside the time and distance tolerances", () => {
    const { tick, counter } = counterAt();
    counter.register(down());
    tick(MULTI_CLICK_MS);
    expect(
      counter.register(down({ clientX: 100 + MULTI_CLICK_SLOP_PX, clientY: 100 + MULTI_CLICK_SLOP_PX })),
    ).toBe(2);
  });

  it("does not pair a right-click with a preceding left-click", () => {
    const { tick, counter } = counterAt();
    counter.register(down({ button: 0 }));
    tick(20);
    expect(counter.register(down({ button: 2 }))).toBe(1);
  });

  it("does not pair a pen tap with a preceding mouse click", () => {
    const { tick, counter } = counterAt();
    counter.register(down({ pointerType: "mouse" }));
    tick(20);
    expect(counter.register(down({ pointerType: "pen" }))).toBe(1);
  });

  it("reset() drops the streak", () => {
    const { tick, counter } = counterAt();
    counter.register(down());
    counter.reset();
    tick(20);
    expect(counter.register(down())).toBe(1);
  });
});
