// SS8 — Grid math: note-value <-> tick conversion, bar/beat/tick
// decomposition, and snapping. Pure integer arithmetic throughout; ticks
// are always integers at `PPQ` (SS8).

import type { BarBeatTick, TimeSignature, Ticks } from "../types";
import { TICKS_PER_WHOLE_NOTE } from "../types";
import { assertIntegerTicks, assertPositiveFinite } from "./dev";

/** How to round when snapping a tick to a grid (default `'nearest'`). */
export type SnapMode = "nearest" | "floor" | "ceil";

/**
 * Ticks spanning one note of the given `denominator` (4 = quarter, 16 =
 * sixteenth, ...). `TICKS_PER_WHOLE_NOTE / denominator`, e.g.
 * `ticksPerNote(16) === 240`. Throws if the division isn't exact (ticks
 * must stay integers) or `denominator` isn't a positive power-of-two-ish
 * note value.
 *
 * `triplet: true` gives the triplet subdivision of that note value (2/3 of
 * the straight duration, e.g. a 1/8 triplet is 160 ticks) and is allowed to
 * produce values a straight grid couldn't, as long as the result is still
 * an integer.
 */
export function ticksPerNote(denominator: number, triplet = false): Ticks {
  assertPositiveFinite(denominator, "ticksPerNote(denominator)");
  const straight = TICKS_PER_WHOLE_NOTE / denominator;
  const ticks = triplet ? (straight * 2) / 3 : straight;
  if (!Number.isInteger(ticks)) {
    throw new Error(
      `ticksPerNote: denominator ${String(denominator)}${triplet ? " (triplet)" : ""} does not divide ${String(TICKS_PER_WHOLE_NOTE)} ticks evenly`,
    );
  }
  return ticks;
}

/** Ticks spanning one beat under `sig` (a beat is one note of `denominator`). */
export function ticksPerBeat(sig: TimeSignature): Ticks {
  return ticksPerNote(sig.denominator);
}

/** Ticks spanning one bar under `sig` (`numerator` beats). */
export function ticksPerBar(sig: TimeSignature): Ticks {
  assertPositiveFinite(sig.numerator, "ticksPerBar(sig.numerator)");
  return sig.numerator * ticksPerBeat(sig);
}

/**
 * Decomposes an absolute tick position into 1-based `bar`/`beat` plus the
 * tick remainder within the beat. `tick` may be negative (bars/beats before
 * the start count down through 0); the tick component is always in
 * `[0, ticksPerBeat)`.
 */
export function tickToBarBeatTick(
  tick: Ticks,
  sig: TimeSignature,
): BarBeatTick {
  assertIntegerTicks(tick, "tickToBarBeatTick(tick)");
  const perBeat = ticksPerBeat(sig);
  const perBar = ticksPerBar(sig);
  const bar = Math.floor(tick / perBar);
  const tickInBar = tick - bar * perBar;
  const beat = Math.floor(tickInBar / perBeat);
  const tickInBeat = tickInBar - beat * perBeat;
  return { bar: bar + 1, beat: beat + 1, tick: tickInBeat };
}

/** Inverse of `tickToBarBeatTick`. */
export function barBeatTickToTick(
  bbt: BarBeatTick,
  sig: TimeSignature,
): Ticks {
  assertIntegerTicks(bbt.tick, "barBeatTickToTick(bbt.tick)");
  const perBeat = ticksPerBeat(sig);
  const perBar = ticksPerBar(sig);
  return (bbt.bar - 1) * perBar + (bbt.beat - 1) * perBeat + bbt.tick;
}

/**
 * Formats a `BarBeatTick` for the ruler (SS8: "formatting bar.beat.tick"),
 * e.g. `1.1.000`. `tick` is zero-padded to 3 digits (960 PPQ never needs
 * more).
 */
export function formatBarBeatTick(bbt: BarBeatTick): string {
  return `${String(bbt.bar)}.${String(bbt.beat)}.${String(bbt.tick).padStart(3, "0")}`;
}

/**
 * Snaps `tick` to the nearest multiple of `gridTicks` (SS9/SS10). `mode`
 * selects the rounding direction; defaults to `'nearest'` (ties round up,
 * matching `Math.round`).
 */
export function snapTicks(
  tick: Ticks,
  gridTicks: Ticks,
  mode: SnapMode = "nearest",
): Ticks {
  assertIntegerTicks(tick, "snapTicks(tick)");
  assertIntegerTicks(gridTicks, "snapTicks(gridTicks)");
  assertPositiveFinite(gridTicks, "snapTicks(gridTicks)");
  const ratio = tick / gridTicks;
  const snapped =
    mode === "floor"
      ? Math.floor(ratio)
      : mode === "ceil"
        ? Math.ceil(ratio)
        : Math.round(ratio);
  // `|| 0` folds `-0` (e.g. Math.round(-100 / 240) === -0) to `0` so ticks
  // near the origin never carry a negative-zero sign that would otherwise
  // leak into equality checks and serialization.
  return snapped * gridTicks || 0;
}
