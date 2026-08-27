// Pure one-pole (RC) lowpass — the "cutoff-ish tone" control for
// `core.poly-synth` (SS7/SS14). No audio node: this is plain per-sample math,
// applied to the mixed voice signal inside the worklet processor, and
// unit-testable head-on.
//
// The coefficient depends only on the cutoff, and the cutoff comes from a
// k-rate `AudioParam` — one value per 128-sample block. `Math.exp` is
// therefore computed only when the cutoff actually changes, not once per
// sample: at SS2's ~40-voice budget the render loop's per-sample cost is the
// figure that budget is made of, and a transcendental for a value that cannot
// change inside the block is pure waste.

export class OnePoleLowpass {
  private readonly sampleRate: number;
  private y = 0;
  /** Cutoff the cached `alpha` was computed for; NaN until the first call. */
  private cachedCutoffHz = Number.NaN;
  private alpha = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 1;
  }

  reset(): void {
    this.y = 0;
  }

  /** True when the filter has decayed to (exactly enough) zero, so a stretch
   *  of silent input can only produce silent output — see the idle fast path
   *  in the worklet processor. */
  get isSettled(): boolean {
    return Math.abs(this.y) < 1e-12;
  }

  /**
   * Recomputes the coefficient for `cutoffHz`, if it changed. Call once per
   * block (the cutoff is k-rate); `process` then costs one multiply-add.
   */
  setCutoff(cutoffHz: number): void {
    if (cutoffHz === this.cachedCutoffHz) return;
    const nyquist = this.sampleRate / 2;
    const clamped = Math.min(nyquist - 1, Math.max(1, cutoffHz));
    this.alpha = 1 - Math.exp((-2 * Math.PI * clamped) / this.sampleRate);
    this.cachedCutoffHz = cutoffHz;
  }

  /** Filters one sample at the given cutoff (Hz), which may change per call.
   *  `cutoffHz` is optional: omit it after a `setCutoff` for this block. */
  process(x: number, cutoffHz?: number): number {
    if (cutoffHz !== undefined) this.setCutoff(cutoffHz);
    this.y += this.alpha * (x - this.y);
    return this.y;
  }
}
