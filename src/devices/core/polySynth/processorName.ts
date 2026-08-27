// The one place `core.poly-synth`'s `registerProcessor` name lives, so the
// main-thread `AudioWorkletNode` constructor (../polySynth.ts) and the
// worklet's own `registerProcessor` call (../../../worklets/poly-synth-processor.ts)
// can never drift apart.
export const POLY_SYNTH_PROCESSOR_NAME = "core-poly-synth";
