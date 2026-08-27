// SS4 — Parameter system (`load-bearing`). The spine of the app.
//
// A parameter is a named, typed, range-bounded value with a stable id.
// Knobs bind to parameters, automation lanes bind to parameters, presets are
// bags of parameter values. Design rule (SS4): no device, mixer, or engine
// code ever exposes a raw `AudioParam` or setter to the UI — if a control
// needs to exist, a descriptor must exist.
//
// Implemented by the `param-registry` package in src/params/.

import type { Milliseconds, Normalized, Seconds, Unsub } from "./common";
import type { ParamId } from "./ids";

export type { ParamId } from "./ids";

/**
 * Real <-> normalized mapping used for knob sweep and curve display only
 * (SS4 "Value semantics"). Stored/serialized values are always real units.
 *
 * - `'linear'` — even sweep across [min, max].
 * - `'log'`    — logarithmic; requires min > 0 (Hz, ms).
 * - `{ pow: k }` — normalized^k curve, k > 0.
 */
export type Taper = "linear" | "log" | { pow: number };

export type ParamKind = "continuous" | "stepped" | "enum" | "toggle";

/**
 * SS4, verbatim in shape. Optional members additionally admit `undefined`
 * so descriptor factories (`p.db`, `p.hz`, ... in src/params) can spread
 * partial option objects under `exactOptionalPropertyTypes`.
 */
export interface ParamDescriptor {
  /**
   * Global param address once registered (see `ParamId`). Inside a
   * `DeviceDefinition.params` list this field carries the *device-local* id
   * (e.g. `"cutoff"`); the harness rewrites it to the full path when it
   * registers the instance's params (SS7 "ids relative to the instance").
   */
  id: ParamId;
  /** Human label, e.g. `"Cutoff"`. */
  label: string;
  kind: ParamKind;
  /** Bounds in real units (Hz, dB, st, %, ms). */
  min: number;
  max: number;
  defaultValue: number;
  /** UI + curve mapping. Defaults to `'linear'` when absent. */
  taper?: Taper | undefined;
  /** pan/detune: center detent, +/- readout. */
  bipolar?: boolean | undefined;
  /** Increment for `kind: 'stepped'`. */
  step?: number | undefined;
  /** Choice labels for `kind: 'enum'`; value is the index into this array. */
  labels?: string[] | undefined;
  /** Unit suffix for readouts, e.g. `"Hz"`, `"dB"`. */
  unit?: string | undefined;
  /** 1200 -> `"1.20 kHz"`. Must be total over [min, max]. */
  toText(v: number): string;
  /** Parses user entry (`"1.2k"`, `"-6db"`); `null` when unparseable. */
  fromText(s: string): number | null;
  /** Default de-zipper ramp (~15 ms) applied on the fast path. */
  smoothingMs?: Milliseconds | undefined;
}

/**
 * SS4 per-param state machine. UI state living in the registry — it never
 * dirties the project document.
 *
 * `free` (the control rules) -> `automated` (a lane drives it) ->
 * `overridden` (user touched an automated control during playback;
 * automation for that param is suspended until *Re-enable automation*).
 */
export type ParamState = "free" | "automated" | "overridden";

/** Who is writing a value on the fast path (SS3 "param fast path"). */
export type ParamWriteSource = "user" | "automation";

/**
 * SS4, verbatim. The one sanctioned UI<->engine bridge.
 *
 * Invariants every implementation and caller must honour:
 * - values in/out are REAL units, never normalized;
 * - `setLive` writes at gesture/automation rate and must NOT touch the
 *   document; `commit()` at gesture end produces exactly one undo entry;
 * - at most one of `bindAudioParam` / `bindMessage` is in effect at a time —
 *   the later call replaces the earlier binding;
 * - `onChange` callbacks are coalesced to rAF and are for repaint only.
 */
export interface ParamHandle {
  readonly desc: ParamDescriptor;
  readonly state: ParamState;
  /** Committed document value. */
  base(): number;
  /** What the DSP currently sees (automation/override included). */
  live(): number;
  setLive(v: number, source: ParamWriteSource): void;
  /** Gesture end -> one document command. */
  commit(): void;
  /** Fast path A: drive a native `AudioParam` (with de-zipper ramps). */
  bindAudioParam(p: AudioParam): void;
  /**
   * Fast path B: drive a worklet/message target. `when` is audio-clock
   * seconds and may be up to a look-ahead window in the future (SS12), so an
   * implementation MUST honour it — post it to the worklet, or hand it to an
   * `AudioParam` method that takes a time. A binding whose engine target has
   * no scheduling primitive at all (a plain JS property such as
   * `BiquadFilterNode.type`) applies at the next render quantum instead, and
   * must say so at the binding site: an SS11 automation write would otherwise
   * take effect early by that whole window.
   */
  bindMessage(fn: (v: number, when: Seconds) => void): void;
  /** UI repaint subscription, coalesced to rAF. */
  onChange(cb: (v: number) => void): Unsub;
}

/**
 * SS4 "Registry and id scheme": a single `ParamRegistry` maps
 * `ParamId -> ParamHandle`. Mixer params register exactly like device params.
 *
 * Implemented in src/params/. M0 needs `register` / `get` / `require`;
 * the override members exist for M3's *Re-enable automation* pill and may be
 * trivially satisfied (no automation exists yet) in M0.
 */
export interface ParamRegistry {
  /**
   * Registers a descriptor whose `id` is a full `ParamId` and returns its
   * handle. Registering an already-registered id is an error.
   */
  register(desc: ParamDescriptor): ParamHandle;
  /** Removes a param (device/channel disposal). Safe on unknown ids. */
  unregister(id: ParamId): void;
  get(id: ParamId): ParamHandle | undefined;
  /** Like `get`, but throws when the id is unknown. */
  require(id: ParamId): ParamHandle;
  has(id: ParamId): boolean;
  /** Every live handle; the automation lane menu is a filtered view of this. */
  list(): readonly ParamHandle[];
  /** True while any param is in `'overridden'` state (transport pill). */
  hasOverrides(): boolean;
  /** Returns every overridden param to `'automated'`. */
  reenableAutomation(): void;
  /** Fires when handles are added/removed (not on value changes). */
  onRegistryChange(cb: () => void): Unsub;
}

/**
 * Taper mapping helpers, implemented once in src/params/ and used by the
 * control kit (SS5) and automation lanes (SS11). Declared here so the
 * mapping boundary has one shape everywhere.
 */
export interface TaperMapping {
  toNormalized(desc: ParamDescriptor, real: number): Normalized;
  fromNormalized(desc: ParamDescriptor, n: Normalized): number;
  /** Clamps + quantizes (step/enum/toggle) a real value to the descriptor. */
  clamp(desc: ParamDescriptor, real: number): number;
}
