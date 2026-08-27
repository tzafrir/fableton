// Transport & look-ahead scheduler (SS12): the two-clock design — a dedicated
// Worker posts a tick every 25 ms, and on each tick the engine schedules note
// events out to `ctx.currentTime + 0.20` with exact audio-clock timestamps.

export { createTransport, createEngineTransport } from "./transport";
export type { EngineTransport, EngineTransportDeps } from "./transport";

export { createClipEventSource } from "./clipEventSource";

export type { Clock, ClockKind } from "./clock";
export { createDefaultClock, createTimerClock, createWorkerClock } from "./clock";
export type { ManualClock } from "./manualClock";
export { createManualClock } from "./manualClock";
