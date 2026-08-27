import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClockTickMessage } from "../../types";
import { DEFAULT_TICK_INTERVAL_MS } from "../../types";
import { createDefaultClock, createTimerClock, createWorkerClock } from "./clock";
import { createManualClock } from "./manualClock";

describe("createTimerClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks at the requested interval with an incrementing sequence", () => {
    const clock = createTimerClock();
    const seqs: number[] = [];
    clock.onTick((seq) => seqs.push(seq));

    clock.start(DEFAULT_TICK_INTERVAL_MS);
    vi.advanceTimersByTime(100);
    expect(seqs).toEqual([0, 1, 2, 3]);

    clock.stop();
    vi.advanceTimersByTime(100);
    expect(seqs).toEqual([0, 1, 2, 3]);

    clock.dispose();
  });

  it("restarts the sequence and fans out to every subscriber", () => {
    const clock = createTimerClock();
    const a: number[] = [];
    const b: number[] = [];
    clock.onTick((s) => a.push(s));
    const unsubB = clock.onTick((s) => b.push(s));

    clock.start(10);
    vi.advanceTimersByTime(30);
    unsubB();
    clock.start(10);
    vi.advanceTimersByTime(20);

    expect(a).toEqual([0, 1, 2, 0, 1]);
    expect(b).toEqual([0, 1, 2]);
    clock.dispose();
  });

  it("falls back to the default period for a nonsense interval", () => {
    const clock = createTimerClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));
    clock.start(0);
    vi.advanceTimersByTime(DEFAULT_TICK_INTERVAL_MS);
    expect(seqs).toEqual([0]);
    clock.dispose();
  });

  it("identifies itself as the main-thread timer clock", () => {
    const clock = createTimerClock();
    expect(clock.kind).toBe("timer");
    clock.dispose();
  });

  it("dispose stops the timer", () => {
    const clock = createTimerClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));
    clock.start(10);
    clock.dispose();
    vi.advanceTimersByTime(100);
    expect(seqs).toEqual([]);
  });
});

describe("createDefaultClock", () => {
  it("falls back to a main-thread timer where there is no Worker", () => {
    // jsdom has no `Worker`; the browser path is covered by the M0 e2e suite.
    expect(typeof Worker).toBe("undefined");
    vi.useFakeTimers();
    const clock = createDefaultClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));
    clock.start(10);
    vi.advanceTimersByTime(25);
    clock.dispose();
    vi.useRealTimers();
    expect(seqs).toEqual([0, 1]);
  });
});

describe("createManualClock", () => {
  it("identifies itself as the manual clock", () => {
    expect(createManualClock().kind).toBe("manual");
  });

  it("only ticks while running and counts dropped ticks", () => {
    const clock = createManualClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));

    clock.tick();
    expect(seqs).toEqual([]);

    clock.start(25);
    expect(clock.running).toBe(true);
    expect(clock.intervalMs).toBe(25);
    clock.tickTimes(3);
    expect(seqs).toEqual([0, 1, 2]);
    expect(clock.droppedTicks).toBe(0);

    clock.tickDropping(4);
    expect(clock.droppedTicks).toBe(4);

    clock.stop();
    clock.tick();
    expect(seqs).toHaveLength(4);
  });
});

describe("clock worker protocol", () => {
  // The worker module talks to `self`, which under jsdom is `window` — enough
  // to exercise the ClockCommand/ClockTickMessage protocol headlessly.
  let posted: ClockTickMessage[] = [];

  function send(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data }));
  }

  beforeEach(async () => {
    posted = [];
    vi.useFakeTimers();
    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      // The worker reuses one message object, so snapshot it here.
      posted.push({ ...(message as ClockTickMessage) });
    });
    await import("../../workers/clock.worker");
  });

  afterEach(() => {
    send({ type: "stop" });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts a tick per interval after `start`, and stops on `stop`", () => {
    send({ type: "start", intervalMs: 25 });
    vi.advanceTimersByTime(75);
    expect(posted).toEqual([
      { type: "tick", seq: 0, epoch: 0 },
      { type: "tick", seq: 1, epoch: 0 },
      { type: "tick", seq: 2, epoch: 0 },
    ]);

    send({ type: "stop" });
    vi.advanceTimersByTime(100);
    expect(posted).toHaveLength(3);
  });

  it("restarts the sequence on a second `start` and ignores junk messages", () => {
    send({ type: "start", intervalMs: 10 });
    vi.advanceTimersByTime(20);
    send("not-a-command");
    send({ type: "wat" });
    send({ type: "start", intervalMs: 10 });
    vi.advanceTimersByTime(10);
    expect(posted.map((m) => m.seq)).toEqual([0, 1, 0]);
  });

  it("echoes the start command's epoch on every tick of that run", () => {
    send({ type: "start", intervalMs: 10, epoch: 7 });
    vi.advanceTimersByTime(20);
    send({ type: "start", intervalMs: 10, epoch: 8 });
    vi.advanceTimersByTime(10);
    expect(posted.map((m) => `${m.epoch}:${m.seq}`)).toEqual(["7:0", "7:1", "8:0"]);
  });
});

/**
 * The clock the shipped app actually runs (`createDefaultClock` returns it
 * whenever `Worker` exists). jsdom has no `Worker`, so the main-thread half —
 * tick validation, epoch filtering, drop accounting, `dispose` — is covered
 * here against a stub worker rather than only in a browser e2e (SS15: "no
 * browser needed for any of the load-bearing logic").
 */
describe("createWorkerClock", () => {
  class FakeWorker {
    static last: FakeWorker | undefined;
    readonly posted: unknown[] = [];
    terminated = 0;
    private listener: ((event: MessageEvent<unknown>) => void) | null = null;

    constructor(
      readonly url: URL | string,
      readonly options?: unknown,
    ) {
      FakeWorker.last = this;
    }
    addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
      this.listener = listener;
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    terminate(): void {
      this.terminated++;
    }
    /** Delivers a message as the worker would. */
    deliver(data: unknown): void {
      this.listener?.({ data } as MessageEvent<unknown>);
    }
  }

  function installWorker(): void {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker as unknown;
  }

  beforeEach(() => {
    FakeWorker.last = undefined;
    installWorker();
  });

  afterEach(() => {
    delete (globalThis as { Worker?: unknown }).Worker;
  });

  it("starts the worker with an epoch and fans ticks out to subscribers", () => {
    const clock = createWorkerClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));
    clock.start(25);

    const worker = FakeWorker.last!;
    expect(worker.posted).toEqual([{ type: "start", intervalMs: 25, epoch: 1 }]);

    worker.deliver({ type: "tick", seq: 0, epoch: 1 });
    worker.deliver({ type: "tick", seq: 1, epoch: 1 });
    expect(seqs).toEqual([0, 1]);
    clock.dispose();
  });

  it("ignores anything that is not a well-formed tick", () => {
    const clock = createWorkerClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));
    clock.start(25);

    const worker = FakeWorker.last!;
    worker.deliver(null);
    worker.deliver("tick");
    worker.deliver({ type: "pong", seq: 0, epoch: 1 });
    worker.deliver({ type: "tick", seq: "0", epoch: 1 });
    worker.deliver({ type: "tick", epoch: 1 });
    expect(seqs).toEqual([]);

    worker.deliver({ type: "tick", seq: 0, epoch: 1 });
    expect(seqs).toEqual([0]);
    clock.dispose();
  });

  it("counts ticks the worker produced but that never arrived", () => {
    const clock = createWorkerClock();
    clock.onTick(() => {});
    clock.start(25);

    const worker = FakeWorker.last!;
    worker.deliver({ type: "tick", seq: 0, epoch: 1 });
    worker.deliver({ type: "tick", seq: 3, epoch: 1 }); // 1 and 2 never landed
    expect(clock.droppedTicks).toBe(2);
    worker.deliver({ type: "tick", seq: 4, epoch: 1 });
    expect(clock.droppedTicks).toBe(2);
    clock.dispose();
  });

  it("does not count ticks that were in flight when the transport stopped", () => {
    const clock = createWorkerClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));
    clock.start(25);

    const worker = FakeWorker.last!;
    worker.deliver({ type: "tick", seq: 0, epoch: 1 });
    clock.stop();
    // `stop` is only a message: these were posted before the worker saw it.
    worker.deliver({ type: "tick", seq: 1, epoch: 1 });
    worker.deliver({ type: "tick", seq: 2, epoch: 1 });
    clock.start(25);
    worker.deliver({ type: "tick", seq: 3, epoch: 1 }); // still the old run
    worker.deliver({ type: "tick", seq: 0, epoch: 3 }); // the new one

    expect(seqs).toEqual([0, 0]);
    expect(clock.droppedTicks).toBe(0);
    clock.dispose();
  });

  it("dispose stops the worker, terminates it, and suppresses later posts", () => {
    const clock = createWorkerClock();
    clock.start(25);
    const worker = FakeWorker.last!;
    clock.dispose();

    expect(worker.terminated).toBe(1);
    expect(worker.posted.at(-1)).toEqual({ type: "stop" });

    const postedCount = worker.posted.length;
    clock.start(25);
    clock.stop();
    clock.dispose();
    expect(worker.posted).toHaveLength(postedCount);
    expect(worker.terminated).toBe(1);
  });

  it("identifies itself as the worker clock", () => {
    const clock = createWorkerClock();
    expect(clock.kind).toBe("worker");
    clock.dispose();
  });

  it("createDefaultClock picks the worker clock when the platform has one", () => {
    const clock = createDefaultClock();
    clock.start(25);
    expect(clock.kind).toBe("worker");
    expect(FakeWorker.last?.posted).toEqual([{ type: "start", intervalMs: 25, epoch: 1 }]);
    clock.dispose();
  });

  it("createDefaultClock falls back to the timer clock when Worker construction fails", () => {
    (globalThis as { Worker?: unknown }).Worker = function Broken(): never {
      throw new Error("module workers are not allowed here");
    } as unknown;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const clock = createDefaultClock();
    const seqs: number[] = [];
    clock.onTick((s) => seqs.push(s));
    clock.start(10);
    vi.advanceTimersByTime(25);
    clock.dispose();
    vi.useRealTimers();
    expect(seqs).toEqual([0, 1]);

    // The fallback IS the throttled main-thread timer SS12 rejects, so it
    // must be both announced and identifiable — a silent degradation would
    // sound identical in a foreground tab and drop out in a hidden one.
    expect(clock.kind).toBe("timer");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/background tabs/);
    warn.mockRestore();
  });
});
