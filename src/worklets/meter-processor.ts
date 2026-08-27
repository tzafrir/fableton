// SS6 "Metering" — the per-strip metering AudioWorkletProcessor.
//
// One instance per channel strip, constructed with `processorOptions`:
// `{ sab: SharedArrayBuffer, slot: number }`. Each 128-frame block it writes
// the block's peak and RMS into its slab slot (src/engine/meter/slab.ts owns
// the layout) and produces NO output — it is a pure tap. Zero allocation in
// `process` (SS12 guardrail): the Float32Array view and the `[peak, rms]`
// scratch are built once in the constructor, the measurement writes into that
// scratch (`blockPeakRmsInto`, an out-param so no result object is born per
// quantum), and every loop is an index loop — a `for...of` allocates an
// iterator per call, which is the same guardrail by a quieter name.
//
// The class is exported and the math lives in slab.ts so this file
// unit-tests by driving `process()` directly (SS15), same pattern as
// poly-synth-processor.ts.

import { FLOATS_PER_SLOT, PEAK_OFFSET, RMS_OFFSET, blockPeakRmsInto, writeMeterSlot } from "../engine/meter/slab";
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
  /** Scratch `[peak, rms]`, allocated once — see the zero-allocation note. */
  readonly #measured = new Float32Array(FLOATS_PER_SLOT);

  constructor(options?: AudioWorkletNodeOptions & MeterProcessorOptions) {
    super(options);
    const sab = options?.processorOptions?.sab;
    this.slot = options?.processorOptions?.slot ?? 0;
    this.view = sab instanceof SharedArrayBuffer ? new Float32Array(sab) : null;
  }

  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (this.view !== null && input !== undefined && input.length > 0) {
      // Out-param form + index loops: nothing here may allocate (see header).
      blockPeakRmsInto(input, this.#measured);
      writeMeterSlot(this.view, this.slot, this.#measured[PEAK_OFFSET] ?? 0, this.#measured[RMS_OFFSET] ?? 0);
    }
    return true;
  }
}

registerProcessor(METER_PROCESSOR_NAME, MeterProcessor as never);
