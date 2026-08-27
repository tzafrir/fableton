import { afterEach, describe, expect, it } from "vitest";
import { createViewport } from "./viewport";
import {
  NO_MODIFIERS,
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
