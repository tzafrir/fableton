// Pure per-voice ADSR envelope generator for `core.poly-synth` (SS7/SS14
// "ADSR" param group). No AudioNode, no worklet globals — driven purely by
// sample counts, so it is unit-testable head-on and reusable verbatim inside
// the worklet processor (src/worklets/poly-synth-processor.ts).
//
// `next()` is called once per output sample and returns the envelope's
// current amplitude in [0, 1]. `noteOn` does NOT reset the level to 0 — a
// retriggered/stolen voice ramps from wherever it currently is, avoiding a
// hard discontinuity when the voice allocator reuses a still-sounding voice.

export type EnvelopeStage = "idle" | "attack" | "decay" | "sustain" | "release";

export interface AdsrConfig {
  /** Time to rise from the current level to peak (1.0). */
  attackSeconds: number;
  /** Time to fall from peak to `sustainLevel`. */
  decaySeconds: number;
  /** Level held after decay, 0..1. */
  sustainLevel: number;
  /** Time to fall from the level-at-release to 0. */
  releaseSeconds: number;
}

/** Floor so a 0 s stage never divides by zero or produces an infinite rate. */
const MIN_STAGE_SECONDS = 1 / 1_000_000;

/** Boundary slack absorbing float-summation drift (e.g. ten additions of 0.1). */
const STAGE_EPSILON = 1e-9;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class AdsrEnvelope {
  private readonly sampleRate: number;
  private stage: EnvelopeStage = "idle";
  private level = 0;
  private attackInc = 0;
  private decayInc = 0;
  private sustainLevel = 0;
  private releaseSeconds = MIN_STAGE_SECONDS;
  private releaseInc = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 1;
  }

  get currentStage(): EnvelopeStage {
    return this.stage;
  }

  get currentLevel(): number {
    return this.level;
  }

  /** True once the voice has finished its release tail and is silent. */
  get isIdle(): boolean {
    return this.stage === "idle";
  }

  /** Starts (or retriggers) the envelope; `releaseSeconds` is remembered for `noteOff`. */
  noteOn(config: AdsrConfig): void {
    const attackSeconds = Math.max(MIN_STAGE_SECONDS, config.attackSeconds);
    const decaySeconds = Math.max(MIN_STAGE_SECONDS, config.decaySeconds);
    const sustain = clamp01(config.sustainLevel);
    this.attackInc = 1 / (attackSeconds * this.sampleRate);
    this.decayInc = Math.max(0, 1 - sustain) / (decaySeconds * this.sampleRate);
    this.sustainLevel = sustain;
    this.releaseSeconds = Math.max(MIN_STAGE_SECONDS, config.releaseSeconds);
    this.stage = "attack";
  }

  /** Moves into the release stage; a no-op on an already-idle voice. */
  noteOff(): void {
    if (this.stage === "idle") return;
    this.releaseInc = this.level / (this.releaseSeconds * this.sampleRate);
    this.stage = "release";
  }

  /**
   * Forces the voice fully off, immediately — a hard cut with no ramp.
   *
   * Deliberately NOT what `allNotesOff` does: a panic releases its voices
   * (see PolySynthProcessor.applyDue) because a step to zero on the render
   * thread is a click, and SS7 wants every teardown gain-ramped. This exists
   * for re-initialising a voice where no sound can be in flight — e.g. a
   * processor reset before rendering an unrelated stretch of audio.
   */
  reset(): void {
    this.stage = "idle";
    this.level = 0;
  }

  /** Advances exactly one sample and returns the new amplitude, 0..1. */
  next(): number {
    switch (this.stage) {
      case "idle":
        return 0;
      case "attack":
        this.level += this.attackInc;
        // Repeated float addition (e.g. 10 * 0.1) can land a hair under the
        // exact target, so the boundary check needs slack or a stage can
        // linger one extra sample past its nominal length.
        if (this.level >= 1 - STAGE_EPSILON) {
          this.level = 1;
          this.stage = "decay";
        }
        return this.level;
      case "decay":
        this.level -= this.decayInc;
        if (this.level <= this.sustainLevel + STAGE_EPSILON) {
          this.level = this.sustainLevel;
          // Held, even at a sustain level of 0 (reachable: `p.percent
          // ("sustain")` has min 0). Dropping to `idle` here would be
          // "silent", but it also means "this voice is finished" to everything
          // upstream: the processor clears `voice.pitch`, while the
          // `VoiceAllocator` slot stays occupied until the note-off arrives —
          // the two disagree, and `allocate()` starts stealing while up to
          // every slot is provably silent. A voice is idle when its note is
          // over, not when its amplitude reaches zero; `noteOff` from here
          // releases from level 0 and lands in `idle` on the next sample.
          this.stage = "sustain";
        }
        return this.level;
      case "sustain":
        return this.level;
      case "release":
        this.level -= this.releaseInc;
        if (this.level <= STAGE_EPSILON) {
          this.level = 0;
          this.stage = "idle";
        }
        return this.level;
    }
  }
}
