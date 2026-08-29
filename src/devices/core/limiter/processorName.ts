// The one place `core.limiter`'s `registerProcessor` name lives, so the
// main-thread `AudioWorkletNode` constructor (../limiter.ts) and the worklet's
// own `registerProcessor` call (../../../worklets/limiter-processor.ts) cannot
// drift apart.
export const LIMITER_PROCESSOR_NAME = "core-limiter";
