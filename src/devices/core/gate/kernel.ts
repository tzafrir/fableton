// `core.gate` DSP kernel — plain math, shared verbatim between the
// AudioWorkletProcessor (src/worklets/gate-processor.ts) and the unit tests
// (SS15: DSP stays testable head-on in Vitest).
//
// A gate is the compressor's mirror image, and shares its detector: the KEY
// signal (the sidechain input when routed, else the main input) drives a
// one-pole envelope in dB. Above the threshold the gate opens to unity;
// below it, it closes to `floorDb` — not to silence, so a gate can duck
// rather than mute, which is what "range" does on a hardware gate.
//
// HOLD is what separates a gate from an expander, and what makes gated
// reverb work: after the key falls below the threshold the gate stays open
// for `holdMs` before it starts to close. Without it, a key that dips for a
// single sample (any real signal crossing zero) would chatter the gate open
// and shut at audio rate.
//
// Attack and release smooth the GAIN, not the envelope: a gate's character
// is how fast the door moves, and a click-free open is a ramp on the gain.

export interface GateParams {
  thresholdDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  /** Gain applied while closed, in dB. -60 and below reads as silence. */
  floorDb: number;
}

const SILENCE_DB = -120;

export function dbOf(x: number): number {
  return x <= 1e-6 ? SILENCE_DB : 20 * Math.log10(x);
}

export function gainOfDb(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20);
}

/** Per-sample smoothing coefficient for a time constant in ms. */
export function smoothingCoeff(ms: number, sampleRate: number): number {
  if (ms <= 0) return 0;
  return Math.exp(-1 / ((ms / 1000) * sampleRate));
}

export class GateKernel {
  /** Key envelope in dB — persists across blocks. */
  envelopeDb = SILENCE_DB;
  /** Current gate gain, 0..1. Starts CLOSED so a gate never passes a burst
   *  of signal in its first block before the detector has caught up. */
  gain = 0;
  /** Samples left of the hold window; > 0 keeps the gate open. */
  holdSamples = 0;
  /** True while the door is open (diagnostics and tests). */
  open = false;

  constructor(readonly sampleRate: number) {}

  /**
   * Processes one block IN PLACE: `main` channels are scaled by the gate's
   * gain; `key` supplies the detector signal (pass `main` again when no
   * sidechain is routed). All arrays are the same block length.
   */
  process(main: readonly Float32Array[], key: readonly Float32Array[], params: GateParams): void {
    const blockLength = main[0]?.length ?? 0;
    if (blockLength === 0) return;
    // The DETECTOR is deliberately fast and fixed: a gate's own attack/release
    // shape the gain, and a slow detector would smear the transient the gate
    // is supposed to key off.
    const detector = smoothingCoeff(1, this.sampleRate);
    const attack = smoothingCoeff(params.attackMs, this.sampleRate);
    const release = smoothingCoeff(params.releaseMs, this.sampleRate);
    const floor = gainOfDb(params.floorDb);
    const holdLength = Math.max(0, Math.round((params.holdMs / 1000) * this.sampleRate));

    for (let i = 0; i < blockLength; i++) {
      let peak = 0;
      for (let ch = 0; ch < key.length; ch++) {
        const v = Math.abs(key[ch]?.[i] ?? 0);
        if (v > peak) peak = v;
      }
      const inputDb = dbOf(peak);
      // Instant attack on the detector, smoothed decay: the door must open on
      // the transient itself, not `detectorMs` after it.
      this.envelopeDb =
        inputDb > this.envelopeDb ? inputDb : inputDb + detector * (this.envelopeDb - inputDb);

      if (this.envelopeDb >= params.thresholdDb) {
        this.open = true;
        this.holdSamples = holdLength;
      } else if (this.holdSamples > 0) {
        this.holdSamples -= 1;
      } else {
        this.open = false;
      }

      const target = this.open ? 1 : floor;
      const coeff = target > this.gain ? attack : release;
      this.gain = target + coeff * (this.gain - target);

      for (let ch = 0; ch < main.length; ch++) {
        const data = main[ch];
        if (data !== undefined) data[i] = (data[i] ?? 0) * this.gain;
      }
    }
  }
}
