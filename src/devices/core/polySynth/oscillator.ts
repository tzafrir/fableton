// Pure waveform + pitch math for `core.poly-synth` (SS7/SS14). No AudioNode,
// no worklet globals — this module runs on both sides of the boundary: the
// worklet processor (src/worklets/poly-synth-processor.ts) generates samples
// with it, and it is unit-testable in plain Node/Vitest (SS15).

/** The four waveforms the `shape` param selects between, in param-index order. */
export const OSCILLATOR_SHAPES = ["sine", "square", "sawtooth", "triangle"] as const;

export type OscillatorShape = (typeof OSCILLATOR_SHAPES)[number];

/**
 * Rounds/clamps a raw `shape` AudioParam value (0..3, as read k-rate inside
 * the worklet) to one of `OSCILLATOR_SHAPES`.
 */
export function shapeFromIndex(index: number): OscillatorShape {
  const clamped = Math.min(OSCILLATOR_SHAPES.length - 1, Math.max(0, Math.round(index)));
  return OSCILLATOR_SHAPES[clamped] ?? "sine";
}

/**
 * One sample of `shape` at a given oscillator phase. `phase` is wrapped to
 * [0, 1) internally, so callers may pass an ever-increasing accumulator.
 * Output range is [-1, 1].
 */
export function oscillatorSample(shape: OscillatorShape, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case "sine":
      return Math.sin(2 * Math.PI * p);
    case "square":
      return p < 0.5 ? 1 : -1;
    case "sawtooth":
      return 2 * p - 1;
    case "triangle":
      return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
  }
}

/** Equal-temperament MIDI pitch (0-127, A4=69) -> frequency in Hz. */
export function midiToFrequencyHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}
