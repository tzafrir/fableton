// SS12 — the dedicated scheduler clock worker.
//
// "Classic two-clock design": `BaseAudioContext.currentTime` is the only
// truth for *when*, and this timer only decides *how far ahead* to schedule.
// It lives in a Worker rather than on the main thread because main-thread
// timers are throttled (to >= 1 s) in background tabs, which would starve the
// look-ahead window and drop notes the moment the user switches tab.
//
// Protocol is `ClockCommand` (in) / `ClockTickMessage` (out) from
// src/types/transport.ts. `seq` increments once per posted tick so the main
// thread can detect drops; it resets to 0 on every `start`.
//
// Vite recognizes `new Worker(new URL("...", import.meta.url), { type:
// "module" })` natively, so this file needs no bundler configuration.

import type { ClockCommand, ClockTickMessage } from "../types";
import { DEFAULT_TICK_INTERVAL_MS } from "../types";

// `lib.webworker.d.ts` globals conflict with `lib.dom.d.ts` if both are
// loaded into one TS program, so this project's tsconfig uses DOM only. A
// minimal local shape of a module worker's global scope keeps this file
// strictly typed without the conflicting lib.
interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

const worker = self as unknown as WorkerLike;

let timer: ReturnType<typeof setInterval> | null = null;
let seq = 0;

// One preallocated message object: the tick path runs 40x/second forever, and
// SS12's guardrail is "zero allocation in per-tick paths". `postMessage`
// structured-clones the value, so reusing the object is safe.
const tickMessage: ClockTickMessage = { type: "tick", seq: 0, epoch: 0 };

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer(intervalMs: number, epoch: number): void {
  stopTimer();
  seq = 0;
  // Echoed on every tick of this run so the main thread can discard ticks
  // that were already in flight when it stopped or restarted the clock.
  tickMessage.epoch = epoch;
  const period =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_TICK_INTERVAL_MS;
  timer = setInterval(() => {
    tickMessage.seq = seq++;
    worker.postMessage(tickMessage);
  }, period);
}

/** Narrows an untrusted `MessageEvent.data` to a `ClockCommand`. */
function asCommand(data: unknown): ClockCommand | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (type === "stop") return { type: "stop" };
  if (type === "start") {
    const raw = (data as { intervalMs?: unknown }).intervalMs;
    const intervalMs = typeof raw === "number" ? raw : DEFAULT_TICK_INTERVAL_MS;
    const rawEpoch = (data as { epoch?: unknown }).epoch;
    const epoch = typeof rawEpoch === "number" ? rawEpoch : 0;
    return { type: "start", intervalMs, epoch };
  }
  return null;
}

worker.addEventListener("message", (event) => {
  const command = asCommand(event.data);
  if (command === null) return;
  if (command.type === "start") {
    startTimer(command.intervalMs, command.epoch);
  } else {
    stopTimer();
  }
});
