// Minimal ambient declarations for the AudioWorkletGlobalScope.
//
// lib.dom.d.ts only documents AudioWorkletProcessor/registerProcessor in
// doc-comments on AudioWorkletNode — it does not declare the worklet-thread
// globals themselves (they run in a separate realm from window/DOM). Rather
// than swap the whole project's `lib` (which would drop DOM types everywhere
// else) or pull in a full replacement lib package that redeclares dozens of
// DOM interfaces and risks merge conflicts, this declares only the handful
// of symbols worklet code actually touches. Keep this file scoped to
// src/worklets/**.

declare interface AudioParamDescriptor {
  name: string;
  automationRate?: "a-rate" | "k-rate";
  minValue?: number;
  maxValue?: number;
  defaultValue?: number;
}

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: (new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor) & {
    parameterDescriptors?: AudioParamDescriptor[];
  }
): void;

declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
