// SS9's layer discipline, automation skin: what each layer draws, and — the
// load-bearing half — that a frame costs O(VISIBLE) points rather than O(all).
// Assertions read the kit's recording 2D context, not pixels.

import { beforeAll, describe, expect, it } from "vitest";
import type { LayerFrame } from "../../types/render";
import { fakeContextOf, installFakeCanvas2D } from "../kit/testing/fakeCanvas";
import type { LanePreview } from "./handlers";
import {
  createAutomationContentLayer,
  createAutomationGridLayer,
  createAutomationOverlayLayer,
} from "./layers";
import { createAutomationHarness, ENUM_DESC, type AutomationHarness } from "./testing/harness";

beforeAll(() => {
  installFakeCanvas2D();
});

function frameOf(h: AutomationHarness): {
  frame: LayerFrame;
  recorded: ReturnType<typeof fakeContextOf>;
} {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  return {
    frame: {
      ctx,
      viewport: h.viewport,
      widthPx: h.viewport.widthPx,
      heightPx: h.heightPx,
      dpr: 1,
      time: 0,
    },
    recorded: fakeContextOf(canvas),
  };
}

describe("grid layer", () => {
  it("draws bar lines and the lane's value bounds", () => {
    const h = createAutomationHarness();
    const { frame, recorded } = frameOf(h);
    createAutomationGridLayer(h.ctx).draw(frame);
    expect(recorded.callsOf("stroke").length).toBeGreaterThan(2);
    // Half-pixel alignment (SS9), so 1-px lines stay crisp.
    for (const call of recorded.callsOf("moveTo")) {
      const [x, y] = call.args as [number, number];
      expect(Number.isInteger(x - 0.5) || Number.isInteger(y - 0.5)).toBe(true);
    }
  });
});

describe("content layer", () => {
  it("draws one marker per point and a line through them", () => {
    const h = createAutomationHarness();
    const { frame, recorded } = frameOf(h);
    createAutomationContentLayer(h.ctx).draw(frame);
    expect(recorded.callsOf("arc")).toHaveLength(3);
    expect(recorded.ops()).toContain("stroke");
  });

  it("draws nothing for an empty lane or an unbound one", () => {
    const empty = createAutomationHarness({ points: [] });
    const emptyFrame = frameOf(empty);
    createAutomationContentLayer(empty.ctx).draw(emptyFrame.frame);
    expect(emptyFrame.recorded.ops()).toEqual([]);

    // SS7: a lane whose param is gone is kept and greyed, never drawn wrong.
    const greyed = createAutomationHarness({ desc: null });
    const greyedFrame = frameOf(greyed);
    createAutomationContentLayer(greyed.ctx).draw(greyedFrame.frame);
    expect(greyedFrame.recorded.ops()).toEqual([]);
  });

  // SS11: "Stepped/enum/toggle params render and edit as steps." The step is
  // two segments — hold, then jump — and the jump is vertical.
  it("draws a discrete lane as steps", () => {
    const h = createAutomationHarness({
      desc: ENUM_DESC,
      points: [
        [0, 0],
        [1920, 3],
      ],
    });
    const { frame, recorded } = frameOf(h);
    createAutomationContentLayer(h.ctx).draw(frame);
    const lines = recorded.callsOf("lineTo").map((call) => call.args as [number, number]);
    const jump = lines.find((_, i) => i > 0 && lines[i - 1]?.[0] === lines[i]?.[0]);
    expect(jump).toBeDefined();
    // The held run before the jump is flat: same y as the first point.
    expect(lines[0]?.[1]).toBe(h.y(0));
    expect(lines[1]?.[1]).toBe(h.y(0));
  });

  // SS9: "Content culls to the viewport ... O(visible) per frame." A dense
  // imported lane must cost the frame its visible points, not its total.
  it("culls to the visible window, keeping one point either side", () => {
    const dense: [number, number][] = Array.from({ length: 4000 }, (_, i) => [i * 60, i % 100]);
    const h = createAutomationHarness({ points: dense });
    // 800 px at 0.05 px/tick = 16,000 ticks = ~267 of the 4,000 points.
    h.viewport.setScroll(60_000, 0);
    const { frame, recorded } = frameOf(h);
    createAutomationContentLayer(h.ctx).draw(frame);
    const drawn = recorded.callsOf("arc").length;
    expect(drawn).toBeGreaterThan(200);
    expect(drawn).toBeLessThan(280);
    // ...and every marker is inside the window, plus at most one either side.
    const xs = recorded.callsOf("arc").map((call) => (call.args as number[])[0] as number);
    expect(Math.min(...xs)).toBeGreaterThan(-10);
    expect(Math.max(...xs)).toBeLessThan(h.viewport.widthPx + 10);
  });
});

describe("overlay layer", () => {
  it("rings the selected points only", () => {
    const h = createAutomationHarness();
    h.click(h.x(960), h.y(100));
    const { frame, recorded } = frameOf(h);
    createAutomationOverlayLayer(h.ctx, () => null).draw(frame);
    expect(recorded.callsOf("arc")).toHaveLength(1);
  });

  it("draws the marquee rectangle while one is live", () => {
    const h = createAutomationHarness();
    const preview: LanePreview = { kind: "marquee", x0: 10, y0: 20, x1: 60, y1: 90 };
    const { frame, recorded } = frameOf(h);
    createAutomationOverlayLayer(h.ctx, () => preview).draw(frame);
    expect(recorded.callsOf("fillRect")[0]?.args).toEqual([10, 20, 50, 70]);
  });

  it("draws a ghost per moved point", () => {
    const h = createAutomationHarness();
    const preview: LanePreview = {
      kind: "move",
      earliestT: 0,
      ghosts: [
        { fromT: 0, fromV: 0, toT: 240, v: 0 },
        { fromT: 960, fromV: 100, toT: 1200, v: 100 },
      ],
    };
    const { frame, recorded } = frameOf(h);
    createAutomationOverlayLayer(h.ctx, () => preview).draw(frame);
    // Two ghosts, and no selection rings (nothing is selected).
    expect(recorded.callsOf("arc")).toHaveLength(2);
  });

  it("ignores a bend preview whose segment no longer exists", () => {
    const h = createAutomationHarness();
    const preview: LanePreview = { kind: "bend", startT: 12_345, curve: 0.5 };
    const { frame, recorded } = frameOf(h);
    createAutomationOverlayLayer(h.ctx, () => preview).draw(frame);
    expect(recorded.ops()).toEqual([]);
  });
});
