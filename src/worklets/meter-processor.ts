// SS6 "Metering" — the per-strip metering AudioWorkletProcessor.
//
// One instance per channel strip, constructed with `processorOptions`:
// `{ sab: SharedArrayBuffer, slot: number }`. Each 128-frame block it writes
// the block's peak and RMS into its slab slot (src/engine/meter/slab.ts owns
// the layout) and produces NO output — it is a pure tap. Zero allocation in
// `process` (SS12 guardrail): the Float32Array view is built once in the
// constructor.
//
// The class is exported and the math lives in slab.ts so this file
// unit-tests by driving `process()` directly (SS15), same pattern as
// poly-synth-processor.ts.

import { blockPeakRms, writeMeterSlot } from "../engine/meter/slab";
import { METER_PROCESSOR_NAME } from "../engine/meter/processorName";

export { METER_PROCESSOR_NAME };

export interface MeterProcessorOptions {
  processorOptions?: {
    sab?: SharedArrayBuffer;
    slot?: number;
  };
}

export class MeterProcessor extends AudioWorkletProcessor {
  readonly view: Float32Array | null;
  readonly slot: number;

  constructor(options?: AudioWorkletNodeOptions & MeterProcessorOptions) {
    super(options);
    const sab = options?.processorOptions?.sab;
    this.slot = options?.processorOptions?.slot ?? 0;
    this.view = sab instanceof SharedArrayBuffer ? new Float32Array(sab) : null;
  }

  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (this.view !== null && input !== undefined && input.length > 0) {
      const { peak, rms } = blockPeakRms(input);
      writeMeterSlot(this.view, this.slot, peak, rms);
    }
    return true;
  }
}

registerProcessor(METER_PROCESSOR_NAME, MeterProcessor as never);
