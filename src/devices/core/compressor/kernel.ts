// `core.compressor` DSP kernel — plain math, shared verbatim between the
// AudioWorkletProcessor (src/worklets/compressor-processor.ts) and the unit
// tests (SS15: DSP stays testable head-on in Vitest).
//
// A feed-forward peak compressor in the dB domain: the KEY signal (the
// sidechain input when connected, else the main input) drives a one-pole
// envelope follower; the gain computer applies `(threshold - env) * (1 -
// 1/ratio)` above threshold; attack/release smooth the ENVELOPE, so gain
// changes are click-free by construction; makeup is a plain dB offset.

export interface CompressorParams {
  thresholdDb: number;
  /** 1..20; 1 = unity (no compression). */
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

const SILENCE_DB = -120;

export function dbOf(x: number): number {
  return x <= 1e-6 ? SILENCE_DB : 20 * Math.log10(x);
}

export function gainOfDb(db: number): number {
  return 10 ** (db / 20);
}

/** Per-sample smoothing coefficient for a time constant in ms. */
export function smoothingCoeff(ms: number, sampleRate: number): number {
  if (ms <= 0) return 0;
  return Math.exp(-1 / ((ms / 1000) * sampleRate));
}

export class CompressorKernel {
  /** Envelope state in dB — persists across blocks. */
  envelopeDb = SILENCE_DB;
  /** Last applied gain reduction in dB (for meters/tests). */
  reductionDb = 0;
  /**
   * Largest reduction applied during the LAST `process` call, in dB.
   *
   * `reductionDb` is the final sample's, which is the wrong number for a
   * meter: a fast transient can be fully caught and fully released inside one
   * 128-frame block, so an end-of-block sample reports 0 dB for exactly the
   * peaks a compressor exists to catch. Reset per call, so it always describes
   * the block just processed.
   */
  peakReductionDb = 0;

  constructor(readonly sampleRate: number) {}

  /**
   * Processes one block IN PLACE: `main` channels are scaled by the computed
   * gain; `key` supplies the detector signal (pass `main` again when no
   * sidechain is connected). All arrays are the same block length.
   */
  process(
    main: readonly Float32Array[],
    key: readonly Float32Array[],
    params: CompressorParams,
  ): void {
    const blockLength = main[0]?.length ?? 0;
    if (blockLength === 0) return;
    const attack = smoothingCoeff(params.attackMs, this.sampleRate);
    const release = smoothingCoeff(params.releaseMs, this.sampleRate);
    const ratio = Math.max(1, params.ratio);
    const slope = 1 - 1 / ratio;
    const makeup = gainOfDb(params.makeupDb);
    this.peakReductionDb = 0;

    for (let i = 0; i < blockLength; i++) {
      // Peak across key channels.
      let peak = 0;
      for (let ch = 0; ch < key.length; ch++) {
        const v = Math.abs(key[ch]?.[i] ?? 0);
        if (v > peak) peak = v;
      }
      const inputDb = dbOf(peak);
      // One-pole attack/release on the envelope.
      const coeff = inputDb > this.envelopeDb ? attack : release;
      this.envelopeDb = inputDb + coeff * (this.envelopeDb - inputDb);

      const over = this.envelopeDb - params.thresholdDb;
      const reduction = over > 0 ? over * slope : 0;
      this.reductionDb = reduction;
      if (reduction > this.peakReductionDb) this.peakReductionDb = reduction;
      const gain = gainOfDb(-reduction) * makeup;

      for (let ch = 0; ch < main.length; ch++) {
        const data = main[ch];
        if (data !== undefined) data[i] = (data[i] ?? 0) * gain;
      }
    }
  }
}
