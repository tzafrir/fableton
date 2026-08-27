// SS4 "Registry and id scheme" — a single `ParamRegistry` maps
// `ParamId -> ParamHandle`. Mixer params (volume, pan, sends) register exactly
// like device params, which is what makes "automate anything" true rather than
// aspirational: the SS11 lane-creation menu is a filtered view of `list()`.
//
// The free/automated/overridden state machine (SS4) lives HERE, in UI state,
// never in the project document — touching a knob during playback must not
// dirty the project.

import type {
  ParamDescriptor,
  ParamHandle,
  ParamId,
  ParamRegistry,
  ParamState,
  Seconds,
  Unsub,
} from "../types";
import { createFrameBatcher, type FrameSchedulerOptions } from "./frame";
import { ParamHandleImpl, type ParamHandleHost, type RegistryParamHandle } from "./handle";
import { assertTaperUsable, clampToDescriptor } from "./taper";

/** Emitted at gesture end (SS3: one gesture = one command = one undo entry). */
export interface ParamCommit {
  id: ParamId;
  /** The newly committed document value, in real units. */
  value: number;
  /** The value it replaced — the inverse patch M1's undo history needs. */
  previous: number;
  handle: ParamHandle;
}

export interface ParamRegistryOptions extends FrameSchedulerOptions {
  /**
   * Audio-clock reader, normally `() => ctx.currentTime` (SS12: the audio
   * clock is the only truth for *when*). Can be attached later with
   * `setClock` because the registry outlives any single `AudioContext` and
   * the context is only created on a user gesture.
   */
  now?: (() => Seconds) | undefined;
}

/**
 * The frozen `ParamRegistry` contract plus the members the document layer,
 * the automation lanes and the tests need. Everything extra is additive —
 * an `AppParamRegistry` is a `ParamRegistry` anywhere one is asked for.
 */
export interface AppParamRegistry extends ParamRegistry {
  /**
   * The widened handle exists for the caller that CREATED the param — the
   * document layer registering it — and nowhere else. Lookups hand back the
   * SS4 `ParamHandle` surface, so holding the registry never gets you
   * `setBase` / `setAutomated` / `unbind` on a param some device owns: those
   * would be a third write path into the DSP, bypassing `setLive` + `commit`
   * and invisible to `onCommit` (SS3: "there are exactly two ways anything
   * changes at runtime"). The document- and lane-facing operations are
   * registry verbs instead — `load`, `snapshot`, `reenableAutomation`.
   */
  register(desc: ParamDescriptor): RegistryParamHandle;
  get(id: ParamId): ParamHandle | undefined;
  require(id: ParamId): ParamHandle;
  list(): readonly ParamHandle[];

  /** Attach/replace the audio clock (see `ParamRegistryOptions.now`). */
  setClock(now: () => Seconds): void;
  /** Current audio-clock seconds, or 0 before a context exists. */
  now(): Seconds;

  /** Gesture-end commits — the command bus's subscription point (SS3/SS13). */
  onCommit(cb: (commit: ParamCommit) => void): Unsub;
  /** Fires when `hasOverrides()` flips — drives the re-enable pill (SS4). */
  onOverridesChange(cb: (hasOverrides: boolean) => void): Unsub;

  /**
   * Applies saved/undone document values. Values clamp to the current
   * descriptor range (SS4). Returns the ids present in `values` that no live
   * handle claims (device not mounted yet / definition changed) so the caller
   * can report rather than silently drop them.
   */
  load(values: Readonly<Record<ParamId, number>>): readonly ParamId[];
  /** Committed (document) values of every live param — presets, save (SS4). */
  snapshot(): Record<ParamId, number>;

  /** Removes every param matching a predicate (device/channel disposal). */
  unregisterWhere(predicate: (id: ParamId, handle: ParamHandle) => boolean): void;

  /** Runs pending rAF-coalesced `onChange` callbacks now (tests, teardown). */
  flushChanges(): void;
  /** Unregisters everything and cancels any pending frame. */
  dispose(): void;
}

function validateDescriptor(desc: ParamDescriptor): void {
  if (typeof desc.id !== "string" || desc.id.length === 0) {
    throw new Error("ParamRegistry.register: descriptor needs a non-empty id");
  }
  if (!Number.isFinite(desc.min) || !Number.isFinite(desc.max)) {
    throw new Error(`ParamDescriptor "${desc.id}": min/max must be finite numbers`);
  }
  if (desc.max <= desc.min) {
    throw new Error(
      `ParamDescriptor "${desc.id}": max must be greater than min (got ${desc.min}..${desc.max})`,
    );
  }
  if (!Number.isFinite(desc.defaultValue)) {
    throw new Error(`ParamDescriptor "${desc.id}": defaultValue must be a finite number`);
  }
  if (typeof desc.toText !== "function" || typeof desc.fromText !== "function") {
    throw new Error(`ParamDescriptor "${desc.id}": toText/fromText are required (SS4)`);
  }
  assertTaperUsable(desc);
}

export function createParamRegistry(options: ParamRegistryOptions = {}): AppParamRegistry {
  const handles = new Map<ParamId, ParamHandleImpl>();
  const overridden = new Set<ParamHandleImpl>();
  const dirty = new Set<ParamHandleImpl>();
  const registryListeners = new Set<() => void>();
  const commitListeners = new Set<(commit: ParamCommit) => void>();
  const overrideListeners = new Set<(hasOverrides: boolean) => void>();

  let clock: () => Seconds = options.now ?? (() => 0);
  let lastHadOverrides = false;

  const frameOptions: FrameSchedulerOptions = {
    schedule: options.schedule,
    cancel: options.cancel,
  };

  const batcher = createFrameBatcher(() => {
    const batch = [...dirty];
    dirty.clear();
    for (const handle of batch) {
      if (!handle.disposed) handle.emitChange();
    }
  }, frameOptions);

  const notifyRegistryChange = (): void => {
    for (const cb of [...registryListeners]) cb();
  };

  const notifyOverridesMaybeChanged = (): void => {
    const has = overridden.size > 0;
    if (has === lastHadOverrides) return;
    lastHadOverrides = has;
    for (const cb of [...overrideListeners]) cb(has);
  };

  const host: ParamHandleHost = {
    now: () => clock(),
    markDirty(handle) {
      dirty.add(handle);
      batcher.request();
    },
    stateChanged(handle, _previous: ParamState, next: ParamState) {
      if (next === "overridden") overridden.add(handle);
      else overridden.delete(handle);
      notifyOverridesMaybeChanged();
    },
    committed(handle, value, previous) {
      const commit: ParamCommit = { id: handle.id, value, previous, handle };
      for (const cb of [...commitListeners]) cb(commit);
    },
  };

  const removeHandle = (handle: ParamHandleImpl): void => {
    handles.delete(handle.id);
    overridden.delete(handle);
    dirty.delete(handle);
    handle.dispose();
  };

  return {
    register(desc: ParamDescriptor): RegistryParamHandle {
      validateDescriptor(desc);
      if (handles.has(desc.id)) {
        throw new Error(`ParamRegistry: "${desc.id}" is already registered`);
      }
      // Copy: a `DeviceDefinition.params` descriptor is shared by every
      // instance of that device and must never be mutated by the registry.
      const stored: ParamDescriptor = { ...desc };
      const handle = new ParamHandleImpl(stored, host);
      handles.set(stored.id, handle);
      notifyRegistryChange();
      return handle;
    },

    unregister(id: ParamId): void {
      const handle = handles.get(id);
      if (handle === undefined) return;
      removeHandle(handle);
      notifyOverridesMaybeChanged();
      notifyRegistryChange();
    },

    unregisterWhere(predicate): void {
      const doomed = [...handles.values()].filter((h) => predicate(h.id, h));
      if (doomed.length === 0) return;
      for (const handle of doomed) removeHandle(handle);
      notifyOverridesMaybeChanged();
      notifyRegistryChange();
    },

    get(id: ParamId): ParamHandle | undefined {
      return handles.get(id);
    },

    require(id: ParamId): ParamHandle {
      const handle = handles.get(id);
      if (handle === undefined) {
        throw new Error(`ParamRegistry: unknown param "${id}"`);
      }
      return handle;
    },

    has(id: ParamId): boolean {
      return handles.has(id);
    },

    list(): readonly ParamHandle[] {
      return [...handles.values()];
    },

    hasOverrides(): boolean {
      return overridden.size > 0;
    },

    reenableAutomation(): void {
      if (overridden.size === 0) return;
      for (const handle of [...overridden]) handle.reenableAutomation();
      overridden.clear();
      notifyOverridesMaybeChanged();
    },

    onRegistryChange(cb: () => void): Unsub {
      registryListeners.add(cb);
      return () => {
        registryListeners.delete(cb);
      };
    },

    onCommit(cb): Unsub {
      commitListeners.add(cb);
      return () => {
        commitListeners.delete(cb);
      };
    },

    onOverridesChange(cb): Unsub {
      overrideListeners.add(cb);
      return () => {
        overrideListeners.delete(cb);
      };
    },

    setClock(now: () => Seconds): void {
      clock = now;
    },

    now(): Seconds {
      return clock();
    },

    load(values): readonly ParamId[] {
      const unknown: ParamId[] = [];
      for (const [id, value] of Object.entries(values)) {
        const handle = handles.get(id);
        if (handle === undefined) {
          unknown.push(id);
          continue;
        }
        handle.setBase(value);
      }
      return unknown;
    },

    snapshot(): Record<ParamId, number> {
      const out: Record<ParamId, number> = {};
      for (const handle of handles.values()) out[handle.id] = handle.base();
      return out;
    },

    flushChanges(): void {
      batcher.flush();
    },

    dispose(): void {
      batcher.cancel();
      for (const handle of [...handles.values()]) removeHandle(handle);
      dirty.clear();
      notifyOverridesMaybeChanged();
      notifyRegistryChange();
      registryListeners.clear();
      commitListeners.clear();
      overrideListeners.clear();
    },
  };
}

/** Convenience: register a descriptor and set its base value in one call. */
export function registerWithValue(
  registry: AppParamRegistry,
  desc: ParamDescriptor,
  value: number,
): ParamHandle {
  const handle = registry.register(desc);
  handle.setBase(clampToDescriptor(desc, value));
  return handle;
}
