// A `Clock` driven by hand, for deterministic headless tests (SS15: "no
// browser needed for any of the load-bearing logic"). Lives in src/ rather
// than in a test file so integration tests and the offline renderer (M4) can
// step the transport in lockstep with an `OfflineAudioContext`.

import type { Milliseconds } from "../../types";
import type { Clock } from "./clock";
import { createTickSink } from "./clock";

export interface ManualClock extends Clock {
  /** True between `start()` and `stop()`. */
  readonly running: boolean;
  /** Interval the transport asked for, in ms. */
  readonly intervalMs: Milliseconds;
  /** Emits one tick (no-op while stopped). */
  tick(): void;
  /** Emits `count` ticks. */
  tickTimes(count: number): void;
  /** Emits a tick with a deliberately skipped sequence number, to exercise
   *  drop detection. */
  tickDropping(count: number): void;
}

export function createManualClock(): ManualClock {
  // The same subscriber list + drop accounting the real clocks use, so a test
  // asserting on `droppedTicks` through a manual clock is exercising the
  // shipped arithmetic rather than a second copy of it.
  const sink = createTickSink();
  let running = false;
  let intervalMs = 0;
  let seq = 0;
  let disposed = false;

  function emit(next: number): void {
    if (disposed) return;
    sink.emit(next);
  }

  return {
    kind: "manual",
    start(ms: Milliseconds): void {
      running = true;
      intervalMs = ms;
      seq = 0;
      sink.reset();
    },
    stop(): void {
      running = false;
    },
    onTick: sink.onTick,
    get droppedTicks(): number {
      return sink.droppedTicks;
    },
    dispose(): void {
      running = false;
      disposed = true;
    },
    get running(): boolean {
      return running;
    },
    get intervalMs(): Milliseconds {
      return intervalMs;
    },
    tick(): void {
      if (!running) return;
      emit(seq++);
    },
    tickTimes(count: number): void {
      for (let i = 0; i < count; i++) this.tick();
    },
    tickDropping(count: number): void {
      if (!running) return;
      seq += count;
      emit(seq++);
    },
  };
}
