// SS4 "Value semantics" — the ONLY normalization boundary in the app.
//
// Stored, serialized and handle-facing values are always REAL units (Hz, dB,
// st, %, ms). Normalized 0..1 exists solely for knob sweep (SS5) and for the
// vertical axis of automation lanes (SS11), and it is produced here.

import type { Normalized, ParamDescriptor, Taper, TaperMapping } from "../types";

const EPSILON = 1e-12;

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function taperOf(desc: ParamDescriptor): Taper {
  return desc.taper ?? "linear";
}

/**
 * Validates a taper against the descriptor's range. Called by the registry at
 * registration so a broken descriptor fails loudly at author time rather than
 * silently producing NaN in a knob sweep.
 */
export function assertTaperUsable(desc: ParamDescriptor): void {
  const taper = taperOf(desc);
  if (taper === "log" && desc.min <= 0) {
    throw new Error(
      `ParamDescriptor "${desc.id}": taper 'log' requires min > 0 (got ${desc.min})`,
    );
  }
  if (typeof taper === "object") {
    if (!Number.isFinite(taper.pow) || taper.pow <= 0) {
      throw new Error(
        `ParamDescriptor "${desc.id}": taper { pow: k } requires a finite k > 0 (got ${String(taper.pow)})`,
      );
    }
  }
}

/** real -> 0..1 through the descriptor's taper. Always returns a 0..1 value. */
export function toNormalized(desc: ParamDescriptor, real: number): Normalized {
  const { min, max } = desc;
  if (!Number.isFinite(real)) return 0;
  const span = max - min;
  if (Math.abs(span) < EPSILON) return 0;
  const taper = taperOf(desc);
  const clamped = clampNumber(real, Math.min(min, max), Math.max(min, max));

  if (taper === "log" && min > 0 && max > 0) {
    return clampNumber(Math.log(clamped / min) / Math.log(max / min), 0, 1);
  }
  const linear = (clamped - min) / span;
  if (typeof taper === "object" && Number.isFinite(taper.pow) && taper.pow > 0) {
    return clampNumber(Math.pow(clampNumber(linear, 0, 1), 1 / taper.pow), 0, 1);
  }
  return clampNumber(linear, 0, 1);
}

/** 0..1 -> real units through the descriptor's taper (inverse of the above). */
export function fromNormalized(desc: ParamDescriptor, n: Normalized): number {
  const { min, max } = desc;
  const unit = Number.isFinite(n) ? clampNumber(n, 0, 1) : 0;
  const taper = taperOf(desc);

  let real: number;
  if (taper === "log" && min > 0 && max > 0) {
    real = min * Math.pow(max / min, unit);
  } else if (typeof taper === "object" && Number.isFinite(taper.pow) && taper.pow > 0) {
    real = min + (max - min) * Math.pow(unit, taper.pow);
  } else {
    real = min + (max - min) * unit;
  }
  return clampToDescriptor(desc, real);
}

/**
 * Clamps a real value into the descriptor's range and quantizes it for the
 * discrete kinds. SS4: "Loaded values clamp to the current descriptor range."
 * Total — a NaN/undefined-ish input resolves to the (clamped) default.
 */
export function clampToDescriptor(desc: ParamDescriptor, real: number): number {
  const lo = Math.min(desc.min, desc.max);
  const hi = Math.max(desc.min, desc.max);
  const raw = Number.isFinite(real)
    ? real
    : Number.isFinite(desc.defaultValue)
      ? desc.defaultValue
      : lo;
  const clamped = clampNumber(raw, lo, hi);

  switch (desc.kind) {
    case "toggle":
      return clamped >= (lo + hi) / 2 ? hi : lo;
    case "enum": {
      const labelCount = desc.labels?.length ?? 0;
      const maxIndex = labelCount > 0 ? Math.min(hi, labelCount - 1) : hi;
      return clampNumber(Math.round(clamped), lo, maxIndex);
    }
    case "stepped": {
      const step = desc.step;
      if (step === undefined || !Number.isFinite(step) || step <= 0) {
        return clamped;
      }
      const stepped = lo + Math.round((clamped - lo) / step) * step;
      // Rounding can overshoot `hi` when the range is not a whole multiple
      // of `step`; walk back one step rather than reporting an off-grid value.
      const snapped = stepped > hi ? lo + Math.floor((hi - lo) / step) * step : stepped;
      return roundArtefacts(clampNumber(snapped, lo, hi));
    }
    case "continuous":
    default:
      return clamped;
  }
}

/** Kills float dust from repeated step arithmetic (0.30000000000000004 -> 0.3). */
function roundArtefacts(v: number): number {
  const rounded = Number(v.toFixed(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * The SS4 mapping boundary as one object, matching the frozen `TaperMapping`
 * contract. Used by the control kit (SS5) and automation lanes (SS11).
 */
export const taperMapping: TaperMapping = {
  toNormalized,
  fromNormalized,
  clamp: clampToDescriptor,
};
