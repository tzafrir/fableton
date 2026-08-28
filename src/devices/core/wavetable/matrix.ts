// The modulation matrix: six sources, seven destinations, and a param for
// every one of the forty-two cells.
//
// A cell is a real `ParamDescriptor`, not an entry in a list of "slots". That
// costs more params than a slot rack would (forty-two against a rack's
// twenty-four) and buys the thing that matters: every connection has a STABLE
// identity. `LFO 1 -> Cutoff 1` is one param id forever, so it can carry an
// automation lane, be undone on its own, and survive a save — none of which
// survives a slot whose "source" dropdown can be repointed, quietly turning
// an automation lane for one connection into a lane for a different one.
//
// The amounts are the same shape everywhere (-100%..100%, zero by default),
// so the whole matrix is off until something is dialled in, and every cell
// reads the same way: what fraction of this destination's full swing does
// this source get.
//
// Pure data plus one loop — the device declares its params from here, the
// editor draws its grid from here, and the worklet sums through it.

export interface ModSource {
  id: string;
  label: string;
  /** Grid header: has to fit a narrow column. */
  short: string;
  /** True when the source swings both ways (an LFO) rather than 0..1. */
  bipolar: boolean;
  blurb: string;
}

export interface ModTarget {
  id: string;
  label: string;
  short: string;
  /** What a cell at 100% is worth, in the destination's own units. */
  depth: number;
  unit: string;
}

export const MOD_SOURCES: readonly ModSource[] = [
  { id: "env2", label: "Env 2", short: "E2", bipolar: false, blurb: "a second ADSR, free for anything" },
  { id: "env3", label: "Env 3", short: "E3", bipolar: false, blurb: "a third ADSR, free for anything" },
  { id: "lfo1", label: "LFO 1", short: "L1", bipolar: true, blurb: "per-voice LFO" },
  { id: "lfo2", label: "LFO 2", short: "L2", bipolar: true, blurb: "per-voice LFO" },
  { id: "vel", label: "Velocity", short: "Vel", bipolar: false, blurb: "how hard the note was played" },
  { id: "key", label: "Key", short: "Key", bipolar: true, blurb: "note pitch, centred on C3, ±3 octaves" },
];

export const MOD_TARGETS: readonly ModTarget[] = [
  { id: "aPos", label: "Osc A Position", short: "A Pos", depth: 100, unit: "%" },
  { id: "bPos", label: "Osc B Position", short: "B Pos", depth: 100, unit: "%" },
  { id: "pitch", label: "Pitch", short: "Pitch", depth: 24, unit: "st" },
  { id: "cut1", label: "Filter 1 Cutoff", short: "Cut 1", depth: 60, unit: "st" },
  { id: "cut2", label: "Filter 2 Cutoff", short: "Cut 2", depth: 60, unit: "st" },
  { id: "pan", label: "Pan", short: "Pan", depth: 1, unit: "" },
  { id: "amp", label: "Amp", short: "Amp", depth: 1, unit: "" },
];

export const TARGET_A_POS = 0;
export const TARGET_B_POS = 1;
export const TARGET_PITCH = 2;
export const TARGET_CUT1 = 3;
export const TARGET_CUT2 = 4;
export const TARGET_PAN = 5;
export const TARGET_AMP = 6;

export const SOURCE_ENV2 = 0;
export const SOURCE_ENV3 = 1;
export const SOURCE_LFO1 = 2;
export const SOURCE_LFO2 = 3;
export const SOURCE_VEL = 4;
export const SOURCE_KEY = 5;

export const SOURCE_COUNT = MOD_SOURCES.length;
export const TARGET_COUNT = MOD_TARGETS.length;

function capitalize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The device-local param id of one cell, e.g. `modLfo1Cut1`. */
export function modParamId(source: number, target: number): string {
  const s = MOD_SOURCES[source]?.id ?? "src";
  const t = MOD_TARGETS[target]?.id ?? "dst";
  return `mod${capitalize(s)}${capitalize(t)}`;
}

/** What the cell is called wherever a param needs a name of its own — an
 *  automation lane header, the undo entry, a preset diff. */
export function modParamLabel(source: number, target: number): string {
  return `${MOD_SOURCES[source]?.label ?? "?"} → ${MOD_TARGETS[target]?.label ?? "?"}`;
}

/** `[source][target]` — the ids, built once. */
export const MOD_PARAM_IDS: readonly (readonly string[])[] = MOD_SOURCES.map((_, s) =>
  MOD_TARGETS.map((_t, t) => modParamId(s, t)),
);

/** Row-major index of a cell in the flat amount array the worklet keeps. */
export function cellIndex(source: number, target: number): number {
  return source * TARGET_COUNT + target;
}

/**
 * Sums the matrix: `out[t]` gets every source's contribution to destination
 * `t`, already in that destination's own units (semitones, percentage points,
 * a pan offset).
 *
 * `amounts` is row-major and in -1..1 (the param is a percentage; the caller
 * divides once, not forty-two times a block). `sources` holds each source's
 * current value, and `out` is written, never read — so the caller can keep
 * one array per voice and never allocate on the render thread.
 */
export function applyMatrix(
  amounts: Float32Array,
  sources: Float32Array,
  out: Float32Array,
): void {
  for (let t = 0; t < TARGET_COUNT; t++) out[t] = 0;
  for (let s = 0; s < SOURCE_COUNT; s++) {
    const value = sources[s] ?? 0;
    if (value === 0) continue;
    const row = s * TARGET_COUNT;
    for (let t = 0; t < TARGET_COUNT; t++) {
      const amount = amounts[row + t] ?? 0;
      if (amount === 0) continue;
      out[t] = (out[t] ?? 0) + amount * value * (MOD_TARGETS[t]?.depth ?? 1);
    }
  }
}

/** Keytracking source value: -1 three octaves below C3, +1 three above. */
export function keyTrackValue(pitch: number): number {
  const v = (pitch - 60) / 36;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
