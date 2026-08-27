// Descriptor factories (SS4/SS14). Device authors write
//
//   p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1200 })
//
// and get a complete `ParamDescriptor` — sane taper, unit, `toText`,
// `fromText` — so "everything tweakable is a parameter" costs one line.
// Ids here are DEVICE-LOCAL; the harness rewrites them to full paths at
// registration (see `qualifyDescriptor` in ./paramIds).

import type { Milliseconds, ParamDescriptor, Taper } from "../types";
import {
  DB_SUFFIXES,
  HZ_SUFFIXES,
  MS_SUFFIXES,
  PERCENT_SUFFIXES,
  SEMITONE_SUFFIXES,
  dbSilenceFloor,
  formatDb,
  formatHz,
  formatMs,
  formatPan,
  formatPercent,
  formatSemitones,
  parseNumeric,
  parsePan,
  trimNumber,
} from "./text";

/** Options every factory accepts on top of its own range fields. */
export interface DescriptorOptions {
  taper?: Taper | undefined;
  /** Center detent + `±` readout (pan, detune). */
  bipolar?: boolean | undefined;
  unit?: string | undefined;
  /** De-zipper ramp on the fast path; defaults to `DEFAULT_SMOOTHING_MS`. */
  smoothingMs?: Milliseconds | undefined;
  /** Override the generated readout. */
  toText?: ((v: number) => string) | undefined;
  /** Override the generated parser. */
  fromText?: ((s: string) => number | null) | undefined;
}

/**
 * The default value, under either spelling: the SS14 playbook writes
 * `{ defaultValue: 250 }`, the shipped devices write the shorter
 * `{ default: 250 }`. Exactly one of the two is required, so a descriptor can
 * never be built without a default.
 */
export type DefaultOption =
  | { default: number; defaultValue?: undefined }
  | { defaultValue: number; default?: undefined };

/** Either spelling, both optional (factories with a defaulted default). */
type OptionalDefault = {
  default?: number | undefined;
  defaultValue?: number | undefined;
};

function defaultOf(opts: OptionalDefault, fallback = 0): number {
  return opts.default ?? opts.defaultValue ?? fallback;
}

export type RangeOptions = DescriptorOptions & {
  min: number;
  max: number;
} & DefaultOption;

/** `RangeOptions` with defaulted bounds (percent, pan, toggle...). */
type PartialRangeOptions = DescriptorOptions & {
  min?: number | undefined;
  max?: number | undefined;
} & DefaultOption;

function build(
  base: Omit<ParamDescriptor, "toText" | "fromText">,
  fallbackToText: (v: number) => string,
  fallbackFromText: (s: string) => number | null,
  opts: DescriptorOptions,
): ParamDescriptor {
  return {
    ...base,
    toText: opts.toText ?? fallbackToText,
    fromText: opts.fromText ?? fallbackFromText,
  };
}

function common(opts: DescriptorOptions): Pick<
  ParamDescriptor,
  "taper" | "bipolar" | "unit" | "smoothingMs"
> {
  return {
    taper: opts.taper,
    bipolar: opts.bipolar,
    unit: opts.unit,
    smoothingMs: opts.smoothingMs,
  };
}

/** Generic continuous param in whatever unit the caller names. */
function continuous(id: string, label: string, opts: RangeOptions): ParamDescriptor {
  const unit = opts.unit;
  const suffixes = unit === undefined ? { "": 1 } : { "": 1, [unit.toLowerCase()]: 1 };
  return build(
    {
      id,
      label,
      kind: "continuous",
      min: opts.min,
      max: opts.max,
      defaultValue: defaultOf(opts),
      ...common(opts),
    },
    (v) => (unit === undefined ? trimNumber(v) : `${trimNumber(v)} ${unit}`),
    (s) => parseNumeric(s, suffixes),
    opts,
  );
}

/** Frequency in Hz. Log taper by default — that is how ears hear pitch. */
function hz(id: string, label: string, opts: RangeOptions): ParamDescriptor {
  return build(
    {
      id,
      label,
      kind: "continuous",
      min: opts.min,
      max: opts.max,
      defaultValue: defaultOf(opts),
      ...common(opts),
      taper: opts.taper ?? (opts.min > 0 ? "log" : "linear"),
      unit: opts.unit ?? "Hz",
    },
    formatHz,
    (s) => parseNumeric(s, HZ_SUFFIXES),
    opts,
  );
}

/**
 * Level in dB. `-inf` readout at the bottom of a fader-sized range (see
 * `dbSilenceFloor`) — which also means the device binding this param MUST be
 * silent at `min`, not merely very quiet: SS4 makes `toText` the sanctioned
 * readout of the value, so a readout of "-inf dB" over an audible -60 dBFS
 * would be a lie. The harness's gain fast path already honours it
 * (`gainForValue`); a device computing its own dB->linear conversion (e.g. in
 * a worklet) has to apply the same floor.
 */
function db(id: string, label: string, opts: RangeOptions): ParamDescriptor {
  const silenceBelow = dbSilenceFloor(opts.min);
  return build(
    {
      id,
      label,
      kind: "continuous",
      min: opts.min,
      max: opts.max,
      defaultValue: defaultOf(opts),
      ...common(opts),
      unit: opts.unit ?? "dB",
    },
    (v) => formatDb(v, silenceBelow),
    (s) => {
      const lowered = s.trim().toLowerCase();
      if (lowered === "-inf" || lowered === "-inf db" || lowered === "-infinity") {
        return opts.min;
      }
      return parseNumeric(s, DB_SUFFIXES);
    },
    opts,
  );
}

/** Time in milliseconds (attack, delay time, ...). Log taper when min > 0. */
function ms(id: string, label: string, opts: RangeOptions): ParamDescriptor {
  return build(
    {
      id,
      label,
      kind: "continuous",
      min: opts.min,
      max: opts.max,
      defaultValue: defaultOf(opts),
      ...common(opts),
      taper: opts.taper ?? (opts.min > 0 ? "log" : "linear"),
      unit: opts.unit ?? "ms",
    },
    formatMs,
    (s) => parseNumeric(s, MS_SUFFIXES),
    opts,
  );
}

/** Percentage; defaults to a 0..100 range (dry/wet, amount, depth). */
function percent(id: string, label: string, opts: PartialRangeOptions): ParamDescriptor {
  return build(
    {
      id,
      label,
      kind: "continuous",
      min: opts.min ?? 0,
      max: opts.max ?? 100,
      defaultValue: defaultOf(opts),
      ...common(opts),
      unit: opts.unit ?? "%",
    },
    formatPercent,
    (s) => parseNumeric(s, PERCENT_SUFFIXES),
    opts,
  );
}

/** Pitch offset in semitones; bipolar by default. */
function semitones(id: string, label: string, opts: RangeOptions): ParamDescriptor {
  return build(
    {
      id,
      label,
      kind: "continuous",
      min: opts.min,
      max: opts.max,
      defaultValue: defaultOf(opts),
      ...common(opts),
      bipolar: opts.bipolar ?? (opts.min < 0 && opts.max > 0),
      unit: opts.unit ?? "st",
    },
    formatSemitones,
    (s) => parseNumeric(s, SEMITONE_SUFFIXES),
    opts,
  );
}

/** Mixer pan: bipolar -1..1 with an `L / C / R` readout (SS6). */
function pan(
  id: string,
  label = "Pan",
  opts: DescriptorOptions & { min?: number | undefined; max?: number | undefined } & OptionalDefault = {},
): ParamDescriptor {
  return build(
    {
      id,
      label,
      kind: "continuous",
      min: opts.min ?? -1,
      max: opts.max ?? 1,
      defaultValue: defaultOf(opts),
      ...common(opts),
      bipolar: opts.bipolar ?? true,
    },
    formatPan,
    parsePan,
    opts,
  );
}

/** Detented continuous value (voice count, ratio steps, ...). */
function stepped(
  id: string,
  label: string,
  opts: RangeOptions & { step: number },
): ParamDescriptor {
  const unit = opts.unit;
  const suffixes = unit === undefined ? { "": 1 } : { "": 1, [unit.toLowerCase()]: 1 };
  return build(
    {
      id,
      label,
      kind: "stepped",
      min: opts.min,
      max: opts.max,
      defaultValue: defaultOf(opts),
      ...common(opts),
      step: opts.step,
    },
    (v) => (unit === undefined ? trimNumber(v) : `${trimNumber(v)} ${unit}`),
    (s) => parseNumeric(s, suffixes),
    opts,
  );
}

/** Choice param; the VALUE is the index into `labels` (SS4). */
function enumParam(
  id: string,
  label: string,
  opts: DescriptorOptions & { labels: string[] } & OptionalDefault,
): ParamDescriptor {
  const labels = opts.labels;
  return build(
    {
      id,
      label,
      kind: "enum",
      min: 0,
      max: Math.max(0, labels.length - 1),
      defaultValue: defaultOf(opts),
      ...common(opts),
      labels,
      step: 1,
    },
    (v) => labels[Math.round(v)] ?? String(Math.round(v)),
    (s) => {
      const needle = s.trim().toLowerCase();
      const byLabel = labels.findIndex((l) => l.toLowerCase() === needle);
      if (byLabel >= 0) return byLabel;
      const numeric = parseNumeric(s, { "": 1 });
      return numeric === null ? null : Math.round(numeric);
    },
    opts,
  );
}

/** On/off. Value is 0 or 1; automatable as a stepped curve (SS11). */
function toggle(
  id: string,
  label: string,
  opts: DescriptorOptions & {
    default?: boolean | number | undefined;
    defaultValue?: boolean | number | undefined;
    onLabel?: string | undefined;
    offLabel?: string | undefined;
  } = {},
): ParamDescriptor {
  const onLabel = opts.onLabel ?? "On";
  const offLabel = opts.offLabel ?? "Off";
  const rawDefault = opts.default ?? opts.defaultValue ?? 0;
  return build(
    {
      id,
      label,
      kind: "toggle",
      min: 0,
      max: 1,
      defaultValue: typeof rawDefault === "boolean" ? (rawDefault ? 1 : 0) : rawDefault,
      ...common(opts),
      labels: [offLabel, onLabel],
    },
    (v) => (v >= 0.5 ? onLabel : offLabel),
    (s) => {
      const needle = s.trim().toLowerCase();
      if (["on", "1", "true", "yes", onLabel.toLowerCase()].includes(needle)) return 1;
      if (["off", "0", "false", "no", offLabel.toLowerCase()].includes(needle)) return 0;
      return null;
    },
    opts,
  );
}

/**
 * The descriptor factory namespace referenced throughout the plan as `p.*`.
 * Every factory returns a plain `ParamDescriptor` — nothing here is magic,
 * it is just the boilerplate the SS14 playbook does not want repeated.
 */
export const p = {
  continuous,
  hz,
  db,
  ms,
  percent,
  semitones,
  pan,
  stepped,
  enum: enumParam,
  toggle,
  // SS14 lists the helper library as `p.db, p.hz, p.ms, p.pct, p.st, p.enum`
  // and writes the stereo-delay example with `p.time` / `p.pct`. Those live
  // HERE, next to the factories they alias, so a device author copying the
  // playbook into src/devices/core/ (which imports `p` from this module,
  // never from the harness) gets the plan's own spellings.
  /** SS14 spelling of `p.percent` — percentage, 0..100 by default. */
  pct: percent,
  /** SS14 spelling of `p.semitones` — pitch offset in semitones, bipolar. */
  st: semitones,
  /** SS14 spelling of `p.ms` — a time in milliseconds, log taper when min > 0. */
  time: ms,
} as const;
