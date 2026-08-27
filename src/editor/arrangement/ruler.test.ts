// SS8: the ruler is one of exactly two places in the app that converts ticks
// to seconds, and the only place that formats `bar.beat.tick`. Both halves are
// asserted here, plus click-to-seek (snapped through the shared `Grid`).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentStore } from "../../state";
import { createGrid, createViewport } from "../kit";
import { fakeContextOf, installFakeCanvas2D, uninstallFakeCanvas2D } from "../kit/testing/fakeCanvas";
import { DEFAULT_THEME } from "./constants";
import { createRuler, formatSeconds, labelStepTicks } from "./ruler";
import { BAR, makeProject } from "./testing/harness";

describe("formatSeconds", () => {
  it("formats m:ss.mmm and never goes negative", () => {
    expect(formatSeconds(0)).toBe("0:00.000");
    expect(formatSeconds(1)).toBe("0:01.000");
    expect(formatSeconds(61.25)).toBe("1:01.250");
    expect(formatSeconds(-5)).toBe("0:00.000");
  });
});

describe("labelStepTicks", () => {
  it("labels every bar when they are wide, and thins out when zoomed away", () => {
    expect(labelStepTicks(BAR, 0.05)).toBe(BAR); // a bar is 192 px
    expect(labelStepTicks(BAR, 0.005)).toBe(BAR * 3); // a bar is 19.2 px
    expect(labelStepTicks(BAR, 0)).toBe(BAR);
  });
});

describe("the ruler view", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
    uninstallFakeCanvas2D();
  });

  function setup() {
    installFakeCanvas2D();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const store = createDocumentStore(makeProject());
    const viewport = createViewport({ pxPerTick: 0.05, pxPerRow: 40, widthPx: 600, heightPx: 200 });
    const grid = createGrid({ viewport, settings: { mode: "fixed", denominator: 4 } });
    const readout = document.createElement("div");
    const onSeek = vi.fn();
    const ruler = createRuler({
      container,
      viewport,
      grid,
      theme: DEFAULT_THEME,
      doc: store.getState(),
      readout,
      onSeek,
      dpr: 2,
    });
    ruler.resize(600);
    cleanups.push(() => {
      ruler.dispose();
      container.remove();
    });
    const canvas = ruler.element.querySelector("canvas");
    if (canvas === null) throw new Error("no ruler canvas");
    return { ruler, readout, onSeek, viewport, canvas, store };
  }

  it("labels bars as bar.beat.tick", () => {
    const { ruler, canvas } = setup();
    ruler.redraw();
    const labels = fakeContextOf(canvas)
      .callsOf("fillText")
      .map((call) => String(call.args[0]));
    expect(labels.slice(0, 3)).toEqual(["1.1.000", "2.1.000", "3.1.000"]);
  });

  it("renders at devicePixelRatio in device pixels (SS9)", () => {
    const { canvas } = setup();
    expect(canvas.width).toBe(1200);
    expect(canvas.style.width).toBe("600px");
  });

  it("writes the playhead readout in both bar.beat.tick and seconds", () => {
    const { ruler, readout } = setup();
    expect(readout.textContent).toBe("1.1.000  0:00.000");
    // 1920 ticks = 2 beats = 1 s at 120 bpm.
    ruler.setPlayheadTicks(1920);
    expect(readout.textContent).toBe("1.3.000  0:01.000");
  });

  it("moves its playhead marker with a transform, never a redraw", () => {
    const { ruler, canvas } = setup();
    ruler.redraw();
    const before = fakeContextOf(canvas).calls.length;
    ruler.setPlayheadTicks(BAR);
    const marker = ruler.element.querySelector<HTMLElement>(".fbl-arr-ruler-playhead");
    expect(marker?.style.transform).toBe("translateX(192px)");
    expect(fakeContextOf(canvas).calls.length).toBe(before);
  });

  it("seeks on click, snapped through the grid, and bypasses snap on Alt", () => {
    const { ruler, onSeek } = setup();
    const click = (clientX: number, altKey = false): void => {
      ruler.element.dispatchEvent(
        new MouseEvent("pointerdown", { clientX, button: 0, altKey, bubbles: true }),
      );
    };
    click(100); // tick 2000 -> nearest beat = 1920
    expect(onSeek).toHaveBeenLastCalledWith(1920);
    click(100, true);
    expect(onSeek).toHaveBeenLastCalledWith(2000);
    click(-50); // never seeks before the song start
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it("re-reads the time signature when the document changes", () => {
    const { ruler, readout, store } = setup();
    store.dispatch({
      label: "3/4",
      run: (doc) => {
        doc.timeSignature = { numerator: 3, denominator: 4 };
      },
    });
    ruler.setDocument(store.getState());
    ruler.setPlayheadTicks(2880); // one 3/4 bar
    expect(readout.textContent).toBe("2.1.000  0:01.500");
  });
});
