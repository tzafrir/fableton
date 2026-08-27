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

/**
 * How far past a window's start the Firefox `cancelScheduledValues` fallback
 * cancels, so the previous window's ramp — which lands exactly ON that start —
 * survives. One microsecond is far below a single sample frame at any rate we
 * support, so nothing else can hide in the gap.
 */
const CANCEL_EPSILON_S = 1e-6;

/** Discrete kinds jump; ramping an enum index through its neighbours is wrong. */
function isDiscrete(desc: ParamDescriptor): boolean {
  return desc.kind === "enum" || desc.kind === "toggle" || desc.kind === "stepped";
}

export interface BindAudioParamOptions {
  /** Overrides `ParamDescriptor.smoothingMs` for this binding. */
  smoothingMs?: number | undefined;
}

export interface BindMessageOptions {
  /**
   * The message path's CANCEL primitive — the counterpart of fast path A's
   * `cancelAndHoldAtTime`, and the reason `scheduleAutomation` is safe to
   * interrupt. `scheduleAutomation` pushes a whole SS12 look-ahead window of
   * timestamped writes into the binding; without a way to revoke them, a user
   * grabbing the control mid-playback only adds ONE more value at `now` and
   * the ~200 ms of already-queued automation writes keep firing after it,
   * warbling the value between the lane and the hand until the queue drains.
   *
   * A binding whose target can revoke future writes (a `GainNode.gain` behind
   * `setTargetAtTime`, a worklet with a "drop everything after t" message)
   * implements this; one that cannot (a plain JS property applied at the next
   * quantum) omits it and keeps the old behaviour.
   */
  cancelFrom?: ((when: Seconds) => void) | undefined;
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
   * The SS4 `bindMessage` plus the optional cancel primitive. Widening it
   * here (rather than on `ParamHandle`) keeps the frozen UI-facing contract
   * exactly as SS4 writes it while letting the caller that OWNS the binding —
   * the reconciler, the device harness — hand the handle a way to revoke
   * already-queued automation writes. See `BindMessageOptions.cancelFrom`.
   */
  bindMessage(fn: (v: number, when: Seconds) => void, options?: BindMessageOptions): void;
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
  #messageCancelFrom: ((when: Seconds) => void) | null = null;
  /** True while the message binding holds automation writes timestamped in
   *  the future — the state a user override has to revoke (see `#push`). */
  #messageScheduledAhead = false;
  /** Did a `'user'` write move `#live` since the last commit/sync? SS4's
   *  "gesture end -> one document command" is about USER intent, and
   *  `displayAutomation` moves `#live` for display only. */
  #dirtyFromUser = false;
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
    // Only a user write expresses the intent `commit()` is allowed to spend:
    // an automation write moves `#live` for the DSP and the moving knob, and
    // must never become the document's value on a later gesture end.
    this.#dirtyFromUser = source !== "automation";
    this.#writeLive(clampToDescriptor(this.desc, v));
  }

  commit(): void {
    if (this.#disposed) return;
    // A gesture the user never moved commits NOTHING, even when `#live` has
    // drifted away from `#base` — on an automated param `displayAutomation`
    // moves `#live` continuously (SS11: "the knob displays the moving value
    // with the base as a ghost dot"), so a bare press+release on a lane-driven
    // fader would otherwise write the lane's momentary value into the document
    // and produce an undo entry the user never asked for (SS13).
    if (!this.#dirtyFromUser) return;
    this.#dirtyFromUser = false;
    const previous = this.#base;
    const value = this.#live;
    if (Object.is(previous, value)) return; // gesture that changed nothing
    this.#base = value;
    this.#host.committed(this, value, previous);
    this.#host.markDirty(this); // the base "ghost dot" moved (SS5)
  }

  setBase(value: number): void {
    if (this.#disposed) return;
    // The document just spoke (load / undo / redo); whatever the user was
    // holding is superseded, so the next `commit()` needs fresh intent.
    this.#dirtyFromUser = false;
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
    this.#dirtyFromUser = false; // live snapped back to base; nothing to commit
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
    const first = samples[0] as { value: number; when: Seconds };
    const at = Math.max(0, first.when);
    const param = this.#audioParam;
    if (param !== null) {
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(at);
      } else {
        // Firefox: no cancelAndHold. Two things have to be right here, and
        // both were wrong the obvious way. (1) `cancelScheduledValues(at)`
        // deletes every event at time >= `at` — INCLUDING the previous
        // window's final ramp, which ends exactly at `at` because windows are
        // contiguous; the param then holds that ramp's start value and jumps,
        // turning a continuous sweep into a one-step-per-window staircase.
        // Cancelling just past `at` keeps that ramp (only genuinely
        // overlapping tails, i.e. a live lane edit, are dropped).
        // (2) The anchor must be the CURVE's value at `at`, not `#live` —
        // `#live` is the display value at *now*, a whole look-ahead window
        // behind, and writing it at `at` steps the sweep backwards.
        param.cancelScheduledValues(at + CANCEL_EPSILON_S);
        param.setValueAtTime(clampToDescriptor(this.desc, first.value), at);
      }
      for (const s of samples) {
        param.linearRampToValueAtTime(clampToDescriptor(this.desc, s.value), Math.max(at, s.when));
      }
      // The binding's scheduled tail no longer matches #lastPushed.
      this.#lastPushed = Number.NaN;
      return;
    }
    if (this.#message !== null) {
      // The message-path counterpart of `cancelAndHoldAtTime` above: drop the
      // tail this window is about to replace, so a lane edited during playback
      // reschedules instead of playing both curves (SS11).
      this.#messageCancelFrom?.(at);
      for (const s of samples) {
        this.#message(clampToDescriptor(this.desc, s.value), Math.max(0, s.when));
      }
      this.#lastPushed = Number.NaN;
      this.#messageScheduledAhead = true;
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
    // The lane, not the hand, is moving the value now — any older user intent
    // (a drag the user cancelled with Esc, say) is spent and must not let a
    // later bare press+release commit this display value. See `commit()`.
    this.#dirtyFromUser = false;
    this.#live = next;
    this.#host.markDirty(this);
  }

  bindAudioParam(param: AudioParam, options: BindAudioParamOptions = {}): void {
    // Fast path A. The node's `AudioParam` enters here and never leaves.
    this.#audioParam = param;
    this.#message = null;
    this.#messageCancelFrom = null;
    this.#messageScheduledAhead = false;
    this.#bindingSmoothingMs = options.smoothingMs;
    this.#lastPushed = Number.NaN;
    this.#push(this.#live, true);
  }

  bindMessage(fn: (v: number, when: Seconds) => void, options: BindMessageOptions = {}): void {
    // Fast path B (worklets, discrete settings).
    this.#message = fn;
    this.#messageCancelFrom = options.cancelFrom ?? null;
    this.#messageScheduledAhead = false;
    this.#audioParam = null;
    this.#bindingSmoothingMs = undefined;
    this.#lastPushed = Number.NaN;
    this.#push(this.#live, true);
  }

  unbind(): void {
    this.#audioParam = null;
    this.#message = null;
    this.#messageCancelFrom = null;
    this.#messageScheduledAhead = false;
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
    if (this.#message !== null) {
      // Fast path A's `writeAudioParam` cancels from `when` on every write, so
      // a user grabbing an automated control there wins immediately. The
      // message path has to do it explicitly: without this, the look-ahead
      // window `scheduleAutomation` already queued keeps firing AFTER the
      // user's value and drags it back onto the lane's curve.
      if (this.#messageScheduledAhead) {
        this.#messageCancelFrom?.(when);
        this.#messageScheduledAhead = false;
      }
      this.#message(value, when);
    }
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
