import { describe, expect, it, vi } from "vitest";
import { createFrameBatcher } from "./frame";

describe("frame batcher (SS4 rAF coalescing)", () => {
  it("schedules at most one frame for many requests", () => {
    const scheduled: Array<() => void> = [];
    const run = vi.fn();
    const batcher = createFrameBatcher(run, {
      schedule: (cb) => {
        scheduled.push(cb);
        return scheduled.length;
      },
    });

    for (let i = 0; i < 10; i += 1) batcher.request();
    expect(scheduled).toHaveLength(1);
    expect(batcher.pending).toBe(true);

    scheduled[0]?.();
    expect(run).toHaveBeenCalledTimes(1);
    expect(batcher.pending).toBe(false);

    batcher.request();
    expect(scheduled).toHaveLength(2);
  });

  it("flush runs the pending work now and swallows the late frame", () => {
    const scheduled: Array<() => void> = [];
    const run = vi.fn();
    const batcher = createFrameBatcher(run, {
      schedule: (cb) => {
        scheduled.push(cb);
        return scheduled.length;
      },
    });

    batcher.request();
    batcher.flush();
    expect(run).toHaveBeenCalledTimes(1);

    scheduled[0]?.(); // the real frame arrives afterwards: must be a no-op
    expect(run).toHaveBeenCalledTimes(1);

    batcher.flush(); // nothing pending
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending work", () => {
    const run = vi.fn();
    const cancel = vi.fn();
    const scheduled: Array<() => void> = [];
    const batcher = createFrameBatcher(run, {
      schedule: (cb) => {
        scheduled.push(cb);
        return "token";
      },
      cancel,
    });

    batcher.request();
    batcher.cancel();
    expect(cancel).toHaveBeenCalledWith("token");
    expect(batcher.pending).toBe(false);
    scheduled[0]?.();
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to a real frame source when none is injected", async () => {
    const run = vi.fn();
    const batcher = createFrameBatcher(run);
    batcher.request();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
