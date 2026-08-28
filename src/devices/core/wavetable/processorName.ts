// The one place `core.wavetable`'s `registerProcessor` name lives, so the
// main-thread `AudioWorkletNode` constructor (../wavetable.ts) and the
// worklet's own `registerProcessor` call
// (../../../worklets/wavetable-processor.ts) cannot drift apart.
export const WAVETABLE_PROCESSOR_NAME = "core-wavetable";
