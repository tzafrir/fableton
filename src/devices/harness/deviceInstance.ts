// SS7 / SS14 — `deviceInstance(spec)`, the convenience `create()` returns.
//
// A device author lists which device-local param id drives which target and
// gets a complete `DeviceInstance` back: `connectParam` routes each id to its
// fast path (`bindAudioParam` for a native `AudioParam`, `bindMessage` for a
// scaled param, a gain, or a worklet message), note methods are forwarded, and
// `dispose` runs the author's teardown once.
//
// Design rule (SS4) is preserved end to end: the `AudioParam` goes INTO the
// handle here and never comes back out — nothing on the returned instance
// exposes a node or a raw setter.

import type {
  CreateDeviceInstance,
  DeviceInstance,
  DeviceInstanceSpec,
  ParamDescriptor,
  ParamHandle,
  Seconds,
} from "../../types";
import { DEFAULT_SMOOTHING_MS, writeAudioParam } from "../../params/handle";
import { dbSilenceFloor } from "../../params/text";

/** SS7 swap semantics: "~20 ms crossfade" is the harness's default ramp. */
export const DEFAULT_RAMP_OUT_MS = 20;

/** Extra slack after a ramp before nodes are actually disconnected. */
const DISCONNECT_SLACK_MS = 30;

/** Shortest re-check interval while waiting for the audio clock to catch up. */
const RECHECK_MS = 20;

/**
 * How long `runAfterAudioTime` keeps re-checking a stalled audio clock before
 * disconnecting anyway. A context that is not advancing is not producing
 * sound, so the cut it eventually makes is inaudible — but a teardown that
 * waits forever is a leak, and a suspended tab may never come back.
 */
const MAX_DEFERRED_WAIT_MS = 5_000;

/**
 * Wall-clock budget, measured from `dispose(when)`'s `when`, that a device's
 * own fade is allowed to take. The harness cuts the port nodes AROUND a
 * device only after this (see `host.ts`), so the two waits are ordered by
 * construction rather than by coincidence of their default numbers.
 *
 * A device that passes a longer `rampMs` to `rampOutAndDisconnect` must be
 * matched by a longer `DeviceHostOptions.teardownRampMs`, or its ports are
 * cut mid-fade — which is exactly the un-ramped click the fade exists to
 * prevent (SS7 "Removal is the reverse, gain-ramped").
 */
export function deviceTeardownWaitMs(rampMs: number = DEFAULT_RAMP_OUT_MS): number {
  return rampMs + DISCONNECT_SLACK_MS;
}

/**
 * Runs `body` once the AUDIO clock has passed `doneAt`, first waiting
 * `firstWaitMs` of wall-clock time.
 *
 * A fade is scheduled on `ctx.currentTime`; the timer that tears the nodes
 * down afterwards is wall-clock. The two only agree while the context is
 * advancing in real time — a UA-suspended context in a backgrounded tab, a
 * context that never unlocked, or an `OfflineAudioContext` (reachable in M0
 * via `renderDemoOffline`) all break that, and the nodes would then be hard
 * disconnected before the ramp had run at all. So the wall-clock wait is only
 * the first guess: on waking, the audio clock decides whether to cut or wait
 * again, up to `MAX_DEFERRED_WAIT_MS`.
 */
export function runAfterAudioTime(
  ctx: BaseAudioContext | undefined,
  doneAt: Seconds,
  firstWaitMs: number,
  schedule: DelayedCall,
  body: () => void,
): void {
  let waitedMs = 0;
  const attempt = (ms: number): void => {
    schedule(() => {
      waitedMs += ms;
      const remainingMs = ctx === undefined ? 0 : (doneAt - ctx.currentTime) * 1000;
      if (remainingMs > 0 && waitedMs < MAX_DEFERRED_WAIT_MS) {
        attempt(
          Math.max(RECHECK_MS, Math.min(remainingMs, MAX_DEFERRED_WAIT_MS - waitedMs)),
        );
        return;
      }
      body();
    }, ms);
  };
  attempt(firstWaitMs);
}

/** Schedules wall-clock work; injectable so tests need no fake timers. */
export type DelayedCall = (cb: () => void, ms: number) => void;

const defaultSchedule: DelayedCall = (cb, ms) => {
  setTimeout(cb, ms);
};

/**
 * An `AudioParam` whose engine units differ from the param's real units —
 * the SS14 "ms -> s scaler" on a `DelayNode.delayTime`, a percent param
 * driving a 0..1 amount, and so on. Build one with `scaledParam` / `mappedParam`.
 */
export interface ScaledAudioParam {
  param: AudioParam;
  /** Real units (what the descriptor and the document carry) -> engine units. */
  map(real: number): number;
  /** Overrides the descriptor's de-zipper time for this binding. */
  smoothingMs?: number | undefined;
}

/** `{ param, map: v => v * factor }`. */
export function scaledParam(
  param: AudioParam,
  factor: number,
  smoothingMs?: number,
): ScaledAudioParam {
  return { param, map: (real) => real * factor, ...(smoothingMs === undefined ? {} : { smoothingMs }) };
}

/** Arbitrary real -> engine mapping (`v => 2 ** (v / 12)`, ...). */
export function mappedParam(
  param: AudioParam,
  map: (real: number) => number,
  smoothingMs?: number,
): ScaledAudioParam {
  return { param, map, ...(smoothingMs === undefined ? {} : { smoothingMs }) };
}

/** The SS14 delay-time case: a param in ms driving an `AudioParam` in seconds. */
export function msParam(param: AudioParam, smoothingMs?: number): ScaledAudioParam {
  return scaledParam(param, 1 / 1000, smoothingMs);
}

/**
 * A gain target for a param. A single `GainNode` gets the param's value as a
 * linear gain (converted from `%` or `dB` by the descriptor's unit); a PAIR is
 * an equal-power wet/dry crossfade — `[wet, dry]`, exactly the SS14
 * `mix: [wet, dry]` shape.
 */
export type GainTarget = GainNode | readonly [wet: GainNode, dry: GainNode];

/**
 * The SS14 spec object. Extends the frozen `DeviceInstanceSpec` with the
 * harness-owned convenience keys; every addition is optional, so a plain
 * `DeviceInstanceSpec` is always a valid argument (SS7: "the harness may add
 * further optional keys over time; devices must not depend on their absence").
 */
export interface HarnessDeviceInstanceSpec extends DeviceInstanceSpec {
  /** Local id -> `AudioParam` in the same units as the descriptor. */
  gainParams?: Readonly<Record<string, GainTarget>> | undefined;
  /** Local id -> `AudioParam` needing a unit conversion (`msParam(...)`). */
  scaledParams?: Readonly<Record<string, ScaledAudioParam>> | undefined;
  /** Fallback for local ids none of the maps cover (custom binding logic). */
  connectParam?: ((localId: string, handle: ParamHandle) => void) | undefined;
  /** Injectable timer for the deferred half of `dispose` (tests). */
  schedule?: DelayedCall | undefined;
}

/** dB -> linear gain, with a hard zero at the bottom of a fader-sized range. */
export function dbToGain(db: number, silenceAtOrBelow?: number): number {
  if (silenceAtOrBelow !== undefined && db <= silenceAtOrBelow) return 0;
  return 10 ** (db / 20);
}

/**
 * Real value -> linear gain, using the descriptor's unit as the contract:
 * `%` is a percentage (35 -> 0.35), `dB` is decibels, anything else is
 * already a linear amount.
 */
export function gainForValue(desc: ParamDescriptor, value: number): number {
  const unit = desc.unit?.toLowerCase();
  if (unit === "%") return value / 100;
  if (unit === "db") return dbToGain(value, dbSilenceFloor(desc.min));
  return value;
}

/** 0..1 position of a real value for a crossfade pair (`%` aware). */
function fractionForValue(desc: ParamDescriptor, value: number): number {
  const raw = desc.unit === "%" ? value / 100 : value;
  if (!Number.isFinite(raw)) return 0;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}

function smoothingFor(desc: ParamDescriptor, override?: number): number {
  if (override !== undefined) return override;
  if (desc.kind === "enum" || desc.kind === "toggle" || desc.kind === "stepped") return 0;
  return desc.smoothingMs ?? DEFAULT_SMOOTHING_MS;
}

function isGainPair(target: GainTarget): target is readonly [GainNode, GainNode] {
  return Array.isArray(target);
}

/** Every local id a spec claims, with the map that claimed it. */
function collectTargets(spec: HarnessDeviceInstanceSpec): Map<string, string> {
  const owner = new Map<string, string>();
  const claim = (id: string, where: string): void => {
    const existing = owner.get(id);
    if (existing !== undefined) {
      throw new Error(
        `deviceInstance: param "${id}" is bound twice (${existing} and ${where}) — one param, one fast path (SS4)`,
      );
    }
    owner.set(id, where);
  };
  for (const id of Object.keys(spec.audioParams ?? {})) claim(id, "audioParams");
  for (const id of Object.keys(spec.scaledParams ?? {})) claim(id, "scaledParams");
  for (const id of Object.keys(spec.gainParams ?? {})) claim(id, "gainParams");
  for (const id of Object.keys(spec.messageParams ?? {})) claim(id, "messageParams");
  return owner;
}

/**
 * SS14's `deviceInstance({...})`. Satisfies `CreateDeviceInstance`.
 *
 * Binding rules, in the order a local id is looked up:
 *   `audioParams`   -> `handle.bindAudioParam(param)`            (fast path A)
 *   `scaledParams`  -> ramped write of `map(value)`              (fast path B)
 *   `gainParams`    -> node gain, or an equal-power `[wet, dry]` (fast path B)
 *   `messageParams` -> `handle.bindMessage(fn)`                  (fast path B)
 *   `connectParam`  -> the author's own fallback
 * A param in none of them is still registered and automatable; it simply has
 * no live target yet (SS7).
 */
export function deviceInstance(spec: HarnessDeviceInstanceSpec): DeviceInstance {
  collectTargets(spec); // throws on a double-bound local id
  const audioParams = spec.audioParams ?? {};
  const scaledParams = spec.scaledParams ?? {};
  const gainParams = spec.gainParams ?? {};
  const messageParams = spec.messageParams ?? {};
  let disposed = false;

  function bindScaled(handle: ParamHandle, target: ScaledAudioParam): void {
    const smoothing = smoothingFor(handle.desc, target.smoothingMs);
    handle.bindMessage((value, when) => {
      writeAudioParam(target.param, target.map(value), when, smoothing);
    });
  }

  function bindGain(handle: ParamHandle, target: GainTarget): void {
    const desc = handle.desc;
    const smoothing = smoothingFor(desc);
    if (isGainPair(target)) {
      const [wet, dry] = target;
      handle.bindMessage((value, when) => {
        const x = fractionForValue(desc, value);
        // Equal power: the sum of squares stays 1 across the sweep, so a
        // 50/50 mix is not a 6 dB dip in the middle.
        writeAudioParam(wet.gain, Math.sin((x * Math.PI) / 2), when, smoothing);
        writeAudioParam(dry.gain, Math.cos((x * Math.PI) / 2), when, smoothing);
      });
      return;
    }
    handle.bindMessage((value, when) => {
      writeAudioParam(target.gain, gainForValue(desc, value), when, smoothing);
    });
  }

  const instance: DeviceInstance = {
    connectParam(localId: string, handle: ParamHandle): void {
      if (disposed) return;
      const audio = audioParams[localId];
      if (audio !== undefined) {
        handle.bindAudioParam(audio);
        return;
      }
      const scaled = scaledParams[localId];
      if (scaled !== undefined) {
        bindScaled(handle, scaled);
        return;
      }
      const gain = gainParams[localId];
      if (gain !== undefined) {
        bindGain(handle, gain);
        return;
      }
      const message = messageParams[localId];
      if (message !== undefined) {
        handle.bindMessage(message);
        return;
      }
      spec.connectParam?.(localId, handle);
    },

    latencySamples(): number {
      return spec.latencySamples?.() ?? 0;
    },

    dispose(when?: Seconds): void {
      if (disposed) return;
      disposed = true;
      spec.dispose(when);
    },
  };

  // Only present when the device actually implements them: the scheduler and
  // the mixer feature-detect instruments with `typeof inst.noteOn === 'function'`.
  const { noteOn, noteOff, allNotesOff, portRouted, readValue } = spec;
  if (noteOn) instance.noteOn = (pitch, vel, when) => noteOn(pitch, vel, when);
  if (noteOff) instance.noteOff = (pitch, when) => noteOff(pitch, when);
  if (allNotesOff) instance.allNotesOff = (when) => allNotesOff(when);
  // SS6 routing news, same feature-detected shape: the reconciler calls it
  // only on devices that asked for it (`typeof inst.portRouted === 'function'`).
  if (portRouted) instance.portRouted = (portId, routed) => portRouted(portId, routed);
  // SS5 device readouts (gain reduction and friends): a cheap field read the
  // panel polls at rAF. Same feature-detected shape as the rest.
  if (readValue) instance.readValue = (readoutId) => readValue(readoutId);

  return instance;
}

/**
 * The same helper under the frozen `CreateDeviceInstance` signature — the
 * alias exists so the conformance is checked by the compiler, and so callers
 * holding a plain `DeviceInstanceSpec` have a name to reach for.
 */
export const createDeviceInstance: CreateDeviceInstance = deviceInstance;

export interface RampOutOptions {
  /** Fade length in ms; defaults to `DEFAULT_RAMP_OUT_MS` (SS7's ~20 ms).
   *  Anything longer needs a matching `DeviceHostOptions.teardownRampMs` —
   *  see {@link deviceTeardownWaitMs}. */
  rampMs?: number | undefined;
  /**
   * Lets the ramp-out compute how long to wait in wall-clock time before
   * disconnecting when `when` is in the future. Without it the wait is just
   * the ramp length.
   */
  context?: BaseAudioContext | undefined;
  /** Nodes with no gain of their own to disconnect once the fade is done. */
  also?: readonly AudioNode[] | undefined;
  /** Injectable `setTimeout` (tests). */
  schedule?: DelayedCall | undefined;
}

/**
 * SS7 "Removal is the reverse, gain-ramped": fades the given gains to zero
 * starting at `when`, then disconnects every node once the fade has passed.
 * This is what a device's `dispose` calls so a removal never clicks.
 */
export function rampOutAndDisconnect(
  when: Seconds | undefined,
  gains: readonly GainNode[],
  options: RampOutOptions = {},
): void {
  const rampMs = options.rampMs ?? DEFAULT_RAMP_OUT_MS;
  const ctx = options.context;
  const now = ctx?.currentTime ?? 0;
  const at = when !== undefined && Number.isFinite(when) && when > now ? when : now;
  for (const gain of gains) {
    writeAudioParam(gain.gain, 0, at, rampMs);
  }
  const doneAt = at + deviceTeardownWaitMs(rampMs) / 1000;
  const waitMs = Math.max(0, (at - now) * 1000) + deviceTeardownWaitMs(rampMs);
  const schedule = options.schedule ?? defaultSchedule;
  // Wall clock for the first wait, audio clock for the decision: a context
  // that is not advancing must not get its nodes cut before the fade has run.
  runAfterAudioTime(ctx, doneAt, waitMs, schedule, () => {
    for (const gain of gains) gain.disconnect();
    for (const node of options.also ?? []) node.disconnect();
  });
}
