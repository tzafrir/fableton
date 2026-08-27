// Internal dev-mode guards for the time model (SS8: "validate integrality in
// dev"). Not part of the public API — used only inside src/time/.
//
// `import.meta.env.DEV` is Vite's standard dev/prod flag; Vitest runs on
// Vite so it reads `true` in tests too (unless NODE_ENV=production), which
// is what we want: these checks should run in the test suite.

/** True outside of a production build. Guarded so this module never throws
 *  in an environment where `import.meta.env` is absent (e.g. plain node). */
const isDev: boolean =
  typeof import.meta !== "undefined" && typeof import.meta.env !== "undefined"
    ? import.meta.env.DEV !== false
    : true;

/**
 * Throws when `value` is not a finite integer, in EVERY build. Ticks are
 * always integers (SS8); fractional ticks are a bug (equality, snapping, and
 * serialization all rely on integrality).
 *
 * Use this on cold paths — construction, validation — where the throw is part
 * of the API contract rather than a debugging aid. `assertIntegerTicks` is the
 * dev-only variant for hot paths.
 */
export function requireIntegerTicks(value: number, context: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(
      `${context}: expected an integer tick value, got ${String(value)}`,
    );
  }
}

/** Throws when `value` is not a finite, strictly positive number, in every
 *  build. Cold-path counterpart to {@link assertPositiveFinite}. */
export function requirePositiveFinite(value: number, context: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${context}: expected a positive finite number, got ${String(value)}`,
    );
  }
}

/**
 * {@link requireIntegerTicks}, but compiled out of a production build — for
 * per-event/per-tick paths (`secondsAt`, `bpmAt`) where the check would cost
 * real time in the scheduler's inner loop.
 */
export function assertIntegerTicks(value: number, context: string): void {
  if (!isDev) return;
  requireIntegerTicks(value, context);
}

/** Dev-only counterpart to {@link requirePositiveFinite}. */
export function assertPositiveFinite(value: number, context: string): void {
  if (!isDev) return;
  requirePositiveFinite(value, context);
}
