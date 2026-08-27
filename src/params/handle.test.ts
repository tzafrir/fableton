import { beforeEach, describe, expect, it, vi } from "vitest";
import { p } from "./descriptors";
import { createParamRegistry, type AppParamRegistry } from "./registry";
import { DEFAULT_SMOOTHING_MS } from "./handle";
import { deviceParamId } from "./paramIds";

interface ParamCall {
  kind: "cancel" | "set" | "ramp";
  value: number;
  time: number;
}

/** Minimal `AudioParam` stand-in — headless, per SS15 (no browser needed). */
function fakeAudioParam(initial = 0): { param: AudioParam; calls: ParamCall[] } {
  const calls: ParamCall[] = [];
  const param = {
    value: initial,
    cancelScheduledValues(time: number) {
      calls.push({ kind: "cancel", value: Number.NaN, time });
      return param;
    },
    setValueAtTime(value: number, time: number) {
      param.value = value;
      calls.push({ kind: "set", value, time });
      return param;
    },
    linearRampToValueAtTime(value: number, time: number) {
      param.value = value;
      calls.push({ kind: "ramp", value, time });
      return param;
    },
  };
  return { param: param as unknown as AudioParam, calls };
}

const CUTOFF = deviceParamId("t1", "d1", "cutoff");
const cutoffDesc = () => ({
  ...p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1000 }),
  id: CUTOFF,
});

let frames: Array<() => void>;
let clock: number;
let registry: AppParamRegistry;

function runFrame(): void {
  const pending = frames.splice(0, frames.length);
  for (const cb of pending) cb();
}

beforeEach(() => {
  frames = [];
  clock = 0;
  registry = createParamRegistry({
    now: () => clock,
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
  });
});

describe("ParamHandle values (SS4: real units, clamped)", () => {
  it("starts at the clamped default and keeps base/live separate", () => {
    const handle = registry.register(cutoffDesc());
    expect(handle.base()).toBe(1000);
    expect(handle.live()).toBe(1000);

    handle.setLive(2500, "user");
    expect(handle.live()).toBe(2500);
    expect(handle.base()).toBe(1000); // fast path never touches the document
  });

  it("clamps writes to the descriptor range", () => {
    const handle = registry.register(cutoffDesc());
    handle.setLive(1e9, "user");
    expect(handle.live()).toBe(20000);
    handle.setLive(-5, "user");
    expect(handle.live()).toBe(20);
  });

  it("commit() promotes live to base exactly once per gesture", () => {
    const handle = registry.register(cutoffDesc());
    const commits = vi.fn();
    registry.onCommit(commits);

    handle.setLive(1200, "user");
    handle.setLive(1300, "user");
    handle.setLive(1400, "user");
    expect(commits).not.toHaveBeenCalled();

    handle.commit();
    expect(handle.base()).toBe(1400);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      id: CUTOFF,
      value: 1400,
      previous: 1000,
    });

    handle.commit(); // nothing changed since -> no second undo entry
    expect(commits).toHaveBeenCalledTimes(1);
  });
});

describe("fast path A — bindAudioParam (SS4)", () => {
  it("seeds the AudioParam immediately, then de-zippers later writes", () => {
    const handle = registry.register(cutoffDesc());
    const { param, calls } = fakeAudioParam(0);

    clock = 1;
    handle.bindAudioParam(param);
    expect(calls.at(-1)).toEqual({ kind: "set", value: 1000, time: 1 });

    clock = 2;
    calls.length = 0;
    handle.setLive(2000, "user");
    expect(calls.map((c) => c.kind)).toEqual(["cancel", "set", "ramp"]);
    expect(calls[2]).toEqual({
      kind: "ramp",
      value: 2000,
      time: 2 + DEFAULT_SMOOTHING_MS / 1000,
    });
  });

  it("anchors the de-zipper ramp with cancelAndHoldAtTime when the param has it", () => {
    // The ramp must start from the value the param will actually hold at the
    // ramp's start time, not from the one read at scheduling time — see the
    // note in `writeAudioParam`. Browsers that ship `cancelAndHoldAtTime`
    // (everything but Firefox) get that exactly; the `cancel` + `set` fallback
    // above is what the rest fall back to.
    const handle = registry.register(cutoffDesc());
    const { param, calls } = fakeAudioParam(0);
    const held: number[] = [];
    (param as unknown as { cancelAndHoldAtTime: (time: number) => void }).cancelAndHoldAtTime = (
      time: number,
    ) => {
      held.push(time);
    };

    clock = 1;
    handle.bindAudioParam(param);
    clock = 2;
    calls.length = 0;
    handle.setLive(2000, "user");

    expect(held).toEqual([2]);
    expect(calls.map((c) => c.kind)).toEqual(["ramp"]); // no stale re-anchor
    expect(calls[0]).toEqual({
      kind: "ramp",
      value: 2000,
      time: 2 + DEFAULT_SMOOTHING_MS / 1000,
    });
  });

  it("honours a descriptor's smoothingMs and jumps for discrete kinds", () => {
    const slow = registry.register({
      ...p.hz("slow", "Slow", { min: 20, max: 20000, default: 100, smoothingMs: 50 }),
      id: deviceParamId("t1", "d1", "slow"),
    });
    const a = fakeAudioParam(0);
    slow.bindAudioParam(a.param);
    a.calls.length = 0;
    slow.setLive(200, "user");
    expect(a.calls.at(-1)).toEqual({ kind: "ramp", value: 200, time: 0.05 });

    const toggle = registry.register({
      ...p.toggle("bypass", "Bypass"),
      id: deviceParamId("t1", "d1", "bypass"),
    });
    const b = fakeAudioParam(0);
    toggle.bindAudioParam(b.param);
    b.calls.length = 0;
    toggle.setLive(1, "user");
    expect(b.calls.map((c) => c.kind)).toEqual(["cancel", "set"]);
    expect(b.param.value).toBe(1);
  });

  it("does not re-push an unchanged value", () => {
    const handle = registry.register(cutoffDesc());
    const { param, calls } = fakeAudioParam(0);
    handle.bindAudioParam(param);
    calls.length = 0;
    handle.setLive(500, "user");
    const afterFirst = calls.length;
    handle.setLive(500, "user");
    expect(calls.length).toBe(afterFirst);
  });

  it("never hands the AudioParam back out (SS4 design rule)", () => {
    const handle = registry.register(cutoffDesc());
    const { param } = fakeAudioParam(0);
    handle.bindAudioParam(param);
    const reachable = [
      ...Object.values(handle as unknown as Record<string, unknown>),
      handle.base(),
      handle.live(),
      handle.desc,
      handle.state,
    ];
    expect(reachable).not.toContain(param);
    expect(JSON.stringify(Object.keys(handle.desc))).not.toContain("audioParam");
  });
});

describe("fast path B — bindMessage (SS4)", () => {
  it("pushes value + audio-clock time, and replaces an earlier binding", () => {
    const handle = registry.register(cutoffDesc());
    const { param, calls } = fakeAudioParam(0);
    const messages: Array<[number, number]> = [];

    handle.bindAudioParam(param);
    calls.length = 0;

    clock = 4.5;
    handle.bindMessage((v, when) => messages.push([v, when]));
    expect(messages).toEqual([[1000, 4.5]]);

    clock = 5;
    handle.setLive(3000, "user");
    expect(messages.at(-1)).toEqual([3000, 5]);
    expect(calls).toHaveLength(0); // the AudioParam binding is gone
  });

  it("unbind stops all pushes", () => {
    const handle = registry.register(cutoffDesc());
    const messages: number[] = [];
    handle.bindMessage((v) => messages.push(v));
    handle.unbind();
    handle.setLive(900, "user");
    expect(messages).toEqual([1000]);
  });
});

describe("free / automated / overridden (SS4 state machine)", () => {
  it("walks free -> automated -> overridden -> automated", () => {
    const handle = registry.register(cutoffDesc());
    expect(handle.state).toBe("free");

    handle.setAutomated(true);
    expect(handle.state).toBe("automated");

    handle.setLive(800, "automation");
    expect(handle.live()).toBe(800);
    expect(handle.base()).toBe(1000); // base stays the document's ghost value

    handle.setLive(1500, "user");
    expect(handle.state).toBe("overridden");
    expect(registry.hasOverrides()).toBe(true);

    handle.setLive(400, "automation"); // suspended while overridden
    expect(handle.live()).toBe(1500);

    registry.reenableAutomation();
    expect(handle.state).toBe("automated");
    expect(registry.hasOverrides()).toBe(false);
    handle.setLive(400, "automation");
    expect(handle.live()).toBe(400);
  });

  it("freeing an automated param snaps live back to base", () => {
    const handle = registry.register(cutoffDesc());
    handle.setLive(1200, "user");
    handle.commit();
    handle.setAutomated(true);
    handle.setLive(300, "automation");
    expect(handle.live()).toBe(300);

    handle.setAutomated(false);
    expect(handle.state).toBe("free");
    expect(handle.live()).toBe(1200);
  });

  it("reports override transitions for the transport pill", () => {
    const handle = registry.register(cutoffDesc());
    const seen: boolean[] = [];
    registry.onOverridesChange((has) => seen.push(has));

    handle.setAutomated(true);
    handle.setLive(700, "user");
    handle.setLive(750, "user"); // still overridden, no second notification
    registry.reenableAutomation();
    expect(seen).toEqual([true, false]);
  });

  it("keeps state out of the document — commit still works while overridden", () => {
    const handle = registry.register(cutoffDesc());
    const commits = vi.fn();
    registry.onCommit(commits);
    handle.setAutomated(true);
    handle.setLive(2000, "user");
    handle.commit();
    expect(handle.base()).toBe(2000);
    expect(handle.state).toBe("overridden");
    expect(commits).toHaveBeenCalledTimes(1);
  });
});

describe("onChange coalescing (SS4: coalesced to rAF)", () => {
  it("fires once per frame with the latest value", () => {
    const handle = registry.register(cutoffDesc());
    const seen: number[] = [];
    handle.onChange((v) => seen.push(v));

    for (let i = 1; i <= 50; i += 1) handle.setLive(1000 + i, "user");
    expect(seen).toEqual([]);
    expect(frames).toHaveLength(1); // one frame requested, not fifty

    runFrame();
    expect(seen).toEqual([1050]);

    handle.setLive(1111, "user");
    runFrame();
    expect(seen).toEqual([1050, 1111]);
  });

  it("repaints on state changes and on base moves, and unsubscribes cleanly", () => {
    const handle = registry.register(cutoffDesc());
    const cb = vi.fn();
    const unsub = handle.onChange(cb);

    handle.setAutomated(true);
    runFrame();
    expect(cb).toHaveBeenCalledTimes(1);

    handle.setLive(1400, "user"); // -> overridden
    handle.commit(); // base moved (ghost dot)
    runFrame();
    expect(cb).toHaveBeenCalledTimes(2);

    unsub();
    handle.setLive(1500, "user");
    runFrame();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("flushChanges drains without waiting for a frame", () => {
    const handle = registry.register(cutoffDesc());
    const cb = vi.fn();
    handle.onChange(cb);
    handle.setLive(1234, "user");
    registry.flushChanges();
    expect(cb).toHaveBeenCalledWith(1234);
  });
});
