// SS11 curve math + sampler, headless (SS15).

import { describe, expect, it } from "vitest";
import { createParamRegistry } from "../../params";
import { p } from "../../params/descriptors";
import { withParamId } from "../../params";
import { createTempoMap } from "../../time";
import type { AutoPoint, AutomationLane } from "../../types";
import { bendShape, laneValueAt, sampleLane } from "./curve";
import { createAutomationSampler } from "./sampler";

const pts = (list: [number, number, number?][]): AutoPoint[] =>
  list.map(([t, v, curve]) => ({ t, v, curve: curve ?? 0 }));

describe("bendShape", () => {
  it("is identity at curve 0 and pinned at both ends for any bend", () => {
    expect(bendShape(0.25, 0)).toBe(0.25);
    for (const c of [-1, -0.5, 0.5, 1]) {
      expect(bendShape(0, c)).toBe(0);
      expect(bendShape(1, c)).toBe(1);
    }
  });

  it("positive bend eases in, negative eases out", () => {
    expect(bendShape(0.5, 0.8)).toBeLessThan(0.5);
    expect(bendShape(0.5, -0.8)).toBeGreaterThan(0.5);
  });
});

describe("laneValueAt", () => {
  const points = pts([
    [0, 100],
    [960, 200],
    [1920, 0],
  ]);

  it("holds edges, interpolates linearly between straight points", () => {
    expect(laneValueAt(points, -50)).toBe(100);
    expect(laneValueAt(points, 0)).toBe(100);
    expect(laneValueAt(points, 480)).toBe(150);
    expect(laneValueAt(points, 1440)).toBe(100);
    expect(laneValueAt(points, 5000)).toBe(0);
    expect(laneValueAt([], 0)).toBeUndefined();
  });

  it("applies the segment's own bend", () => {
    const bent = pts([
      [0, 0, 1],
      [960, 100],
    ]);
    const mid = laneValueAt(bent, 480);
    expect(mid).toBeDefined();
    expect(mid as number).toBeLessThan(50); // ease-in: slow start
  });
});

describe("sampleLane", () => {
  it("straight segments sample only their endpoints + window bounds", () => {
    const points = pts([
      [0, 0],
      [960, 100],
      [1920, 50],
    ]);
    const samples = sampleLane(points, 0, 1920, 10);
    expect(samples.map((s) => s.tick)).toEqual([0, 960, 1920]);
  });

  it("bent segments subdivide at the step inside the window only", () => {
    const points = pts([
      [0, 0, 0.9],
      [100, 100],
    ]);
    const samples = sampleLane(points, 20, 60, 10);
    const ticks = samples.map((s) => s.tick);
    expect(ticks[0]).toBe(20);
    expect(ticks[ticks.length - 1]).toBe(60);
    expect(ticks.length).toBeGreaterThan(3); // subdivided
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(20);
      expect(t).toBeLessThanOrEqual(60);
    }
  });

  it("consecutive windows join exactly (same boundary sample)", () => {
    const points = pts([
      [0, 0],
      [1000, 100],
    ]);
    const a = sampleLane(points, 0, 500, 50, []);
    const b = sampleLane(points, 500, 1000, 50, []);
    expect(a[a.length - 1]).toEqual(b[0]);
  });
});

describe("automation sampler", () => {
  function setup(bind: "audioParam" | "message") {
    const registry = createParamRegistry({ now: () => 0 });
    const handle = registry.register(
      withParamId(p.continuous("x", "X", { min: 0, max: 100, default: 0, unit: "u" }), "chan:t/dev:d/x"),
    );
    const messages: { value: number; when: number }[] = [];
    const ramps: { value: number; when: number }[] = [];
    if (bind === "message") {
      handle.bindMessage((value, when) => messages.push({ value, when }));
    } else {
      const fakeParam = {
        value: 0,
        cancelAndHoldAtTime: () => undefined,
        cancelScheduledValues: () => undefined,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: (value: number, when: number) => ramps.push({ value, when }),
        setTargetAtTime: () => undefined,
      } as unknown as AudioParam;
      handle.bindAudioParam(fakeParam);
    }
    // Binding pushes the current value once at bind time; that write is not
    // part of any window and would pollute the assertions below.
    messages.length = 0;
    ramps.length = 0;
    const tempo = createTempoMap([{ startTick: 0, bpm: 120 }]); // 960 ticks = 0.5 s
    const lane: AutomationLane = {
      id: "lane-1",
      channelId: "t",
      paramId: "chan:t/dev:d/x",
      points: pts([
        [0, 0],
        [960, 100],
      ]),
      enabled: true,
    };
    const sampler = createAutomationSampler({
      registry,
      tempoMap: () => tempo,
      isMessageBound: () => bind === "message",
    });
    sampler.setLanes([lane]);
    return { registry, handle, sampler, messages, ramps, lane };
  }

  it("audioParam path: linear ramps with window-relative times", () => {
    const { sampler, ramps } = setup("audioParam");
    // Window: ticks 0..960, ending at horizon 1.0 s -> tick 0 is at 0.5 s.
    sampler.fillWindow(1.0, 0, 960);
    expect(ramps.length).toBe(2);
    expect(ramps[0]).toEqual({ value: 0, when: 0.5 });
    expect(ramps[1]).toEqual({ value: 100, when: 1.0 });
  });

  it("message path: control-rate samples, timestamped", () => {
    const { sampler, messages } = setup("message");
    sampler.fillWindow(1.0, 0, 960);
    expect(messages.length).toBeGreaterThan(10); // ~200 Hz over 0.5 s... capped by segment straightness
    const whens = messages.map((m) => m.when);
    expect(Math.min(...whens)).toBeCloseTo(0.5);
    expect(Math.max(...whens)).toBeCloseTo(1.0);
  });

  it("marks its params automated; override drops writes until re-enable", () => {
    const { registry, handle, sampler, ramps } = setup("audioParam");
    registry.setAutomatedIds(sampler.automatedIds());
    expect(handle.state).toBe("automated");

    handle.setLive(42, "user"); // the SS4 touch
    expect(handle.state).toBe("overridden");
    expect(registry.hasOverrides()).toBe(true);

    ramps.length = 0;
    sampler.fillWindow(1.0, 0, 960);
    expect(ramps).toEqual([]); // suspended

    registry.reenableAutomation();
    expect(handle.state).toBe("automated");
    sampler.fillWindow(1.5, 960, 1920);
    expect(ramps.length).toBeGreaterThan(0);
  });

  it("updateDisplay moves live for the knob without touching the binding", () => {
    const { registry, handle, sampler, ramps } = setup("audioParam");
    registry.setAutomatedIds(sampler.automatedIds());
    ramps.length = 0;
    sampler.updateDisplay(480);
    expect(handle.live()).toBeCloseTo(50);
    expect(ramps).toEqual([]);
  });

  it("setAutomatedIds({}) frees the param and restores its base", () => {
    const { registry, handle, sampler } = setup("audioParam");
    registry.setAutomatedIds(sampler.automatedIds());
    sampler.updateDisplay(480);
    expect(handle.live()).toBeCloseTo(50);
    registry.setAutomatedIds(new Set());
    expect(handle.state).toBe("free");
    expect(handle.live()).toBe(handle.base());
  });
});
