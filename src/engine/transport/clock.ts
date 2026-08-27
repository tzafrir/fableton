// SS12 — the JS side of the two-clock design: a `Clock` is anything that can
// call back roughly every `intervalMs`. The transport never reads a clock's
// notion of time (that is `BaseAudioContext.currentTime`'s job); it only uses
// the callback as a "look further ahead now" prompt, so a late, early or
// dropped tick is harmless.
//
// Three implementations:
//   * `createWorkerClock`  — the real one (src/workers/clock.worker.ts).
//   * `createTimerClock`   — main-thread `setInterval` fallback for
//                            environments without `Worker` (headless tests,
//                            and OfflineAudioContext rendering, which never
//                            needs a wall-clock tick at all).
//   * `createManualClock`  — see ./manualClock, for deterministic tests.

import type { ClockCommand, ClockTickMessage, Milliseconds, Unsub } from "../../types";
import { DEFAULT_TICK_INTERVAL_MS } from "../../types";

/**
 * Which of the three implementations a `Clock` is. Load-bearing, not
 * cosmetic: SS12 picks a Worker for exactly one property ("main-thread timers
 * throttle in background tabs"), and `createDefaultClock` degrades to the
 * main-thread timer when the platform refuses a module worker. Without this
 * tag that degradation is invisible — the app would sound identical in the
 * foreground and drop notes the moment the tab is hidden. The transport
 * re-exports it (`EngineTransport.clockKind`), which is what lets the e2e
 * suite assert the SHIPPED app runs the worker clock and not the fallback.
 */
export type ClockKind = "worker" | "timer" | "manual";

/** A repeating "schedule further ahead" prompt. Ticks carry only a sequence
 *  number — never a timestamp, because timestamps come from the audio clock. */
export interface Clock {
  /** Which implementation this is — see `ClockKind`. */
  readonly kind: ClockKind;
  /** (Re)starts ticking every `intervalMs`. Resets the sequence counter. */
  start(intervalMs: Milliseconds): void;
  /** Stops ticking. Safe to call when already stopped. */
  stop(): void;
  /** Subscribes to ticks. Multiple subscribers are allowed. */
  onTick(cb: (seq: number) => void): Unsub;
  /** Ticks the clock source produced but that never arrived (drop detection
   *  via `ClockTickMessage.seq`). Diagnostics only — the scheduler is
   *  time-based and self-heals from drops. */
  readonly droppedTicks: number;
  /** Releases the underlying timer/worker. */
  dispose(): void;
}

/** Shared subscriber list + drop accounting for the clock implementations.
 *  Exported so every `Clock` (including `./manualClock`) counts drops with
 *  the same arithmetic instead of reimplementing it. */
export interface TickSink {
  emit(seq: number): void;
  onTick(cb: (seq: number) => void): Unsub;
  reset(): void;
  readonly droppedTicks: number;
}

export function createTickSink(): TickSink {
  const subscribers: ((seq: number) => void)[] = [];
  let expectedSeq = 0;
  let dropped = 0;

  return {
    emit(seq: number): void {
      if (seq > expectedSeq) dropped += seq - expectedSeq;
      expectedSeq = seq + 1;
      // Index loop, not for..of: the tick path must not allocate an iterator.
      for (let i = 0; i < subscribers.length; i++) {
        subscribers[i]!(seq);
      }
    },
    onTick(cb: (seq: number) => void): Unsub {
      subscribers.push(cb);
      return () => {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    reset(): void {
      expectedSeq = 0;
    },
    get droppedTicks(): number {
      return dropped;
    },
  };
}

/**
 * The real clock: a dedicated module Worker posting `ClockTickMessage`.
 * Throws if the environment has no `Worker` — callers wanting a graceful
 * fallback should use `createDefaultClock`.
 */
export function createWorkerClock(): Clock {
  const worker = new Worker(
    new URL("../../workers/clock.worker.ts", import.meta.url),
    { type: "module" },
  );
  const sink = createTickSink();
  let disposed = false;
  /** Run id. Bumped on every `start`; ticks from an earlier run are stale (see
   *  `ClockTickMessage.epoch`) and must not reach the drop accounting. */
  let epoch = 0;

  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data !== "object" || data === null) return;
    const message = data as Partial<ClockTickMessage>;
    if (message.type !== "tick" || typeof message.seq !== "number") return;
    if (message.epoch !== epoch) return; // in flight when we stopped/restarted
    sink.emit(message.seq);
  });

  function post(command: ClockCommand): void {
    if (disposed) return;
    worker.postMessage(command);
  }

  return {
    kind: "worker",
    start(intervalMs: Milliseconds): void {
      epoch++;
      sink.reset();
      post({ type: "start", intervalMs, epoch });
    },
    stop(): void {
      // Ticks already posted are still queued on this thread; retiring the
      // epoch is what makes them identifiable when they land.
      epoch++;
      post({ type: "stop" });
    },
    onTick: sink.onTick,
    get droppedTicks(): number {
      return sink.droppedTicks;
    },
    dispose(): void {
      if (disposed) return;
      epoch++;
      post({ type: "stop" });
      disposed = true;
      worker.terminate();
    },
  };
}

/**
 * Main-thread `setInterval` clock. Correct but throttled to >= 1 s in
 * background tabs, which is exactly why SS12 puts the real clock in a Worker;
 * this exists for environments that have no `Worker` at all.
 */
export function createTimerClock(): Clock {
  const sink = createTickSink();
  let timer: ReturnType<typeof setInterval> | null = null;
  let seq = 0;

  function clear(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    kind: "timer",
    start(intervalMs: Milliseconds): void {
      clear();
      sink.reset();
      seq = 0;
      const period =
        Number.isFinite(intervalMs) && intervalMs > 0
          ? intervalMs
          : DEFAULT_TICK_INTERVAL_MS;
      timer = setInterval(() => sink.emit(seq++), period);
    },
    stop(): void {
      clear();
    },
    onTick: sink.onTick,
    get droppedTicks(): number {
      return sink.droppedTicks;
    },
    dispose(): void {
      clear();
    },
  };
}

/**
 * The Worker clock where the platform has one, the timer clock otherwise.
 *
 * The fallback is a real degradation — a main-thread `setInterval` is the
 * throttled timer SS12 rejects — so it is announced rather than silent, and
 * the resulting clock says which one it is (`Clock.kind`, surfaced as
 * `EngineTransport.clockKind`) so callers and tests can tell them apart.
 */
export function createDefaultClock(): Clock {
  if (typeof Worker === "undefined") {
    return createTimerClock();
  }
  try {
    return createWorkerClock();
  } catch (err) {
    // e.g. a sandbox that exposes `Worker` but refuses module workers.
    console.warn(
      "[fableton] SS12: no module Worker available for the scheduler clock; " +
        "falling back to a main-thread timer, which browsers throttle to >= 1 s " +
        "in background tabs (playback will drop out when the tab is hidden).",
      err,
    );
    return createTimerClock();
  }
}
