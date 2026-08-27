// SS4 `ParamHandle` — the one sanctioned UI<->engine bridge, and SS3's
// "param fast path": continuous values (knob drags, automation playback)
// write straight to the engine at gesture rate with no document churn, and
// exactly one command is emitted on `commit()`.
//
// Design rule (SS4): no device, mixer, or engine code ever hands a raw
// `AudioParam` to the UI. A device gives its `AudioParam` to the handle here
// (`bindAudioParam`) and it never leaves again — nothing on `ParamHandle`
// returns it, and the registry never stores it anywhere else.

import type {
  ParamDescriptor,
  ParamHandle,
  ParamId,
  ParamState,
  ParamWriteSource,
  Seconds,
  Unsub,
} from "../types";
import { clampToDescriptor } from "./taper";

/** SS4: "default de-zipper ramp (~15 ms) for live sets". */
export const DEFAULT_SMOOTHING_MS = 15;

/** Discrete kinds jump; ramping an enum index through its neighbours is wrong. */
function isDiscrete(desc: ParamDescriptor): boolean {
  return desc.kind === "enum" || desc.kind === "toggle" || desc.kind === "stepped";
}

export interface BindAudioParamOptions {
  /** Overrides `ParamDescriptor.smoothingMs` for this binding. */
  smoothingMs?: number | undefined;
}

/**
 * What the registry (and only the registry) may additionally do to a handle.
 * These are the document- and lane-facing verbs; the SS4 `ParamHandle`
 * surface stays exactly as specified for UI and device code.
 *
 * Enforced, not just documented: `ParamRegistry.get` / `require` / `list`
 * return `ParamHandle`, so this widened view only ever reaches the caller
 * that registered the param (see AppParamRegistry.register).
 */
export interface RegistryParamHandle extends ParamHandle {
  readonly id: ParamId;
  /**
   * Document -> registry sync: project load, undo/redo, or a command that set
   * this param elsewhere. Clamps to the descriptor range (SS4 "Loaded values
   * clamp to the current descriptor range") and, while the param is `free`,
   * carries the new value straight through to the DSP.
   */
  setBase(value: number): void;
  /**
   * An automation lane started (`true`) or stopped (`false`) driving this
   * param (SS11). Freeing a param snaps the live value back to `base()`.
   * A currently `overridden` param stays overridden until re-enabled.
   */
  setAutomated(active: boolean): void;
  /** `overridden` -> `automated` for this one param (SS4 re-enable pill). */
  reenableAutomation(): void;
  /** Drops the current fast-path binding (device disposal). */
  unbind(): void;
}

/** Callbacks the owning registry provides. */
export interface ParamHandleHost {
  /** Audio-clock seconds — `BaseAudioContext.currentTime`, never `Date.now`. */
  now(): Seconds;
  /** Queue this handle's `onChange` subscribers for the next frame. */
  markDirty(handle: ParamHandleImpl): void;
  stateChanged(handle: ParamHandleImpl, previous: ParamState, next: ParamState): void;
  committed(handle: ParamHandleImpl, value: number, previous: number): void;
}

export class ParamHandleImpl implements RegistryParamHandle {
  readonly desc: ParamDescriptor;

  #host: ParamHandleHost;
  #state: ParamState = "free";
  #base: number;
  #live: number;
  #lastPushed = Number.NaN;
  #audioParam: AudioParam | null = null;
  #bindingSmoothingMs: number | undefined = undefined;
  #message: ((v: number, when: Seconds) => void) | null = null;
  #subscribers = new Set<(v: number) => void>();
  #disposed = false;

  constructor(desc: ParamDescriptor, host: ParamHandleHost) {
    this.desc = desc;
    this.#host = host;
    const initial = clampToDescriptor(desc, desc.defaultValue);
    this.#base = initial;
    this.#live = initial;
  }

  get id(): ParamId {
    return this.desc.id;
  }

  get state(): ParamState {
    return this.#state;
  }

  base(): number {
    return this.#base;
  }

  live(): number {
    return this.#live;
  }

  setLive(v: number, source: ParamWriteSource): void {
    if (this.#disposed) return;
    if (source === "automation") {
      // Overridden means "automation for that param is suspended" (SS4) —
      // the lane keeps playing, its writes are simply dropped here.
      if (this.#state === "overridden") return;
    } else if (this.#state === "automated") {
      // The user touched an automated control during playback.
      this.#setState("overridden");
    }
    this.#writeLive(clampToDescriptor(this.desc, v));
  }

  commit(): void {
    if (this.#disposed) return;
    const previous = this.#base;
    const value = this.#live;
    if (Object.is(previous, value)) return; // gesture that changed nothing
    this.#base = value;
    this.#host.committed(this, value, previous);
    this.#host.markDirty(this); // the base "ghost dot" moved (SS5)
  }

  setBase(value: number): void {
    if (this.#disposed) return;
    const next = clampToDescriptor(this.desc, value);
    const changed = !Object.is(next, this.#base);
    this.#base = next;
    if (this.#state === "free") {
      this.#writeLive(next);
    } else if (changed) {
      this.#host.markDirty(this);
    }
  }

  setAutomated(active: boolean): void {
    if (this.#disposed) return;
    if (active) {
      if (this.#state === "free") this.#setState("automated");
      return;
    }
    if (this.#state === "free") return;
    this.#setState("free");
    this.#writeLive(this.#base); // lane deleted/disabled -> knob rules again
  }

  reenableAutomation(): void {
    if (this.#state === "overridden") this.#setState("automated");
  }

  /**
   * SS11 playback write: a look-ahead window of timestamped values from the
   * automation sampler, scheduled onto whichever fast path this handle is
   * bound to. AudioParam path: `cancelAndHoldAtTime` at the window start,
   * then one `linearRampToValueAtTime` per sample (bent segments arrive
   * pre-subdivided by the sampler, so linear chunks trace the curve).
   * Message path: one timestamped message per sample — the worklet
   * interpolates (SS11). Dropped while `overridden` (SS4: "automation for
   * that param is suspended") and when nothing is bound.
   */
  scheduleAutomation(samples: readonly { value: number; when: Seconds }[]): void {
    if (this.#disposed || this.#state === "overridden" || samples.length === 0) return;
    const param = this.#audioParam;
    if (param !== null) {
      const first = samples[0] as { value: number; when: Seconds };
      const at = Math.max(0, first.when);
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(at);
      } else {
        // Firefox: no cancelAndHold — anchor at the current value instead.
        param.cancelScheduledValues(at);
        param.setValueAtTime(this.#live, at);
      }
      for (const s of samples) {
        param.linearRampToValueAtTime(clampToDescriptor(this.desc, s.value), Math.max(at, s.when));
      }
      // The binding's scheduled tail no longer matches #lastPushed.
      this.#lastPushed = Number.NaN;
      return;
    }
    if (this.#message !== null) {
      for (const s of samples) {
        this.#message(clampToDescriptor(this.desc, s.value), Math.max(0, s.when));
      }
      this.#lastPushed = Number.NaN;
    }
  }

  /**
   * SS11 display write: what the moving knob shows NOW. Updates `live` and
   * repaint subscribers WITHOUT touching the binding — the audible values
   * were already scheduled by `scheduleAutomation`. Dropped while
   * `overridden`, same as any automation write.
   */
  displayAutomation(value: number): void {
    if (this.#disposed || this.#state === "overridden") return;
    const next = clampToDescriptor(this.desc, value);
    if (Object.is(next, this.#live)) return;
    this.#live = next;
    this.#host.markDirty(this);
  }

  bindAudioParam(param: AudioParam, options: BindAudioParamOptions = {}): void {
    // Fast path A. The node's `AudioParam` enters here and never leaves.
    this.#audioParam = param;
    this.#message = null;
    this.#bindingSmoothingMs = options.smoothingMs;
    this.#lastPushed = Number.NaN;
    this.#push(this.#live, true);
  }

  bindMessage(fn: (v: number, when: Seconds) => void): void {
    // Fast path B (worklets, discrete settings).
    this.#message = fn;
    this.#audioParam = null;
    this.#bindingSmoothingMs = undefined;
    this.#lastPushed = Number.NaN;
    this.#push(this.#live, true);
  }

  unbind(): void {
    this.#audioParam = null;
    this.#message = null;
    this.#bindingSmoothingMs = undefined;
    this.#lastPushed = Number.NaN;
  }

  onChange(cb: (v: number) => void): Unsub {
    this.#subscribers.add(cb);
    return () => {
      this.#subscribers.delete(cb);
    };
  }

  /** Registry-internal: run the coalesced repaint callbacks for this frame. */
  emitChange(): void {
    if (this.#subscribers.size === 0) return;
    const value = this.#live;
    for (const cb of [...this.#subscribers]) cb(value);
  }

  /** Registry-internal: drop bindings and subscribers (unregister/dispose). */
  dispose(): void {
    this.#disposed = true;
    this.unbind();
    this.#subscribers.clear();
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Which SS3 fast path this handle currently drives (SS11's "two paths,
   *  chosen by the binding" — the sampler picks its sampling density off it). */
  get bindingKind(): "audioParam" | "message" | "none" {
    if (this.#audioParam !== null) return "audioParam";
    if (this.#message !== null) return "message";
    return "none";
  }

  #smoothingMs(): number {
    if (this.#bindingSmoothingMs !== undefined) return this.#bindingSmoothingMs;
    if (isDiscrete(this.desc)) return 0;
    return this.desc.smoothingMs ?? DEFAULT_SMOOTHING_MS;
  }

  #writeLive(value: number): void {
    const changed = !Object.is(value, this.#live);
    this.#live = value;
    this.#push(value, false);
    if (changed) this.#host.markDirty(this);
  }

  #push(value: number, immediate: boolean): void {
    if (!immediate && Object.is(value, this.#lastPushed)) return;
    const when = this.#audioTime();
    this.#lastPushed = value;
    const param = this.#audioParam;
    if (param !== null) {
      writeAudioParam(param, value, when, immediate ? 0 : this.#smoothingMs());
      return;
    }
    if (this.#message !== null) this.#message(value, when);
  }

  #audioTime(): Seconds {
    const now = this.#host.now();
    return Number.isFinite(now) ? now : 0;
  }

  #setState(next: ParamState): void {
    const previous = this.#state;
    if (previous === next) return;
    this.#state = next;
    this.#host.stateChanged(this, previous, next);
    this.#host.markDirty(this); // controls repaint their automation state
  }
}

/**
 * Fast path A write. De-zippered with a short linear ramp so a knob drag or a
 * step in an automation window never clicks. `when` is audio-clock seconds.
 */
export function writeAudioParam(
  param: AudioParam,
  value: number,
  when: Seconds,
  smoothingMs: number,
): void {
  const at = Number.isFinite(when) && when >= 0 ? when : 0;
  if (smoothingMs <= 0) {
    param.cancelScheduledValues(at);
    param.setValueAtTime(value, at);
    return;
  }
  // The ramp has to start from whatever the param will ACTUALLY be at `at`.
  // `at` is not always "now": `DeviceInstance.dispose(when)` and
  // `AppDeviceHost.unmount(id, when)` schedule their fade in the future (SS7's
  // ~20 ms swap crossfade), and anchoring it with the value read here would
  // step the param back to that stale value at `at`, undoing anything that
  // moved it in between — a click at the head of the very fade the ramp exists
  // to prevent. `cancelAndHoldAtTime` is exactly that primitive: it cancels
  // from `at` onward while holding the value the automation would have had
  // there, so the ramp starts from the real curve.
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(at);
  } else {
    // Firefox ships no `cancelAndHoldAtTime`; anchoring at the value read now
    // is exact for `at === now` (every UI write, fast path A) and degrades to
    // the old behaviour only for a scheduled future fade.
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
  }
  param.linearRampToValueAtTime(value, at + smoothingMs / 1000);
}
