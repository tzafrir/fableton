// SS7 lifecycle, executed in ONE place:
//
//   prepare (once per context)  ->  create(ctx, io)
//     ->  register each descriptor as `chan:<id>/dev:<id>/<localId>`
//     ->  connectParam for each  ->  instance is live
//
// Removal is the reverse (SS7 "gain-ramped"): params are unregistered and
// unbound first so nothing can write into a dying node, the instance's own
// `dispose(when)` runs its fade, and the harness-owned port nodes are torn
// down only after that fade has passed.
//
// `create` takes a `BaseAudioContext` — the M4 offline export reuses this
// exact path against an `OfflineAudioContext`, so nothing here may assume a
// live `AudioContext` (no `resume`, no `Date.now`, no `state`).

import type {
  CreateDeviceHost,
  DeviceDefinition,
  DeviceHost,
  DeviceInstance,
  DeviceInstanceId,
  DeviceRegistry,
  DeviceServices,
  DeviceTempo,
  MountDeviceOptions,
  MountedDevice,
  ParamHandle,
  ParamId,
  ParamRegistry,
  Seconds,
} from "../../types";
import { qualifyDescriptor } from "../../params/paramIds";
import { createDeviceIO, type DeviceIOBundle } from "./io";
import {
  DEFAULT_RAMP_OUT_MS,
  deviceTeardownWaitMs,
  runAfterAudioTime,
  type DelayedCall,
} from "./deviceInstance";

/**
 * `prepare` is "one-time async setup per context" (SS7) — a worklet-backed
 * device calling `ctx.audioWorklet.addModule(...)`. Keyed by context AND
 * definition so two hosts sharing one context (main graph + a preview graph)
 * do not double-add, and an offline render context prepares on its own.
 */
const preparedByContext = new WeakMap<BaseAudioContext, Map<DeviceDefinition, Promise<void>>>();

/** Awaits a definition's `prepare` exactly once per context. Idempotent. */
export function prepareDefinition(
  ctx: BaseAudioContext,
  def: DeviceDefinition,
): Promise<void> {
  if (def.prepare === undefined) return Promise.resolve();
  let perContext = preparedByContext.get(ctx);
  if (perContext === undefined) {
    perContext = new Map();
    preparedByContext.set(ctx, perContext);
  }
  const existing = perContext.get(def);
  if (existing !== undefined) return existing;
  const started = Promise.resolve()
    .then(() => def.prepare?.(ctx))
    .then(() => undefined)
    .catch((error: unknown) => {
      // A failed prepare must not poison the context forever: drop the cache
      // entry so a retry (or a second device sharing the module) can try again.
      perContext?.delete(def);
      throw error;
    });
  perContext.set(def, started);
  return started;
}

export interface DeviceHostOptions {
  /** SS8 tempo, as devices may see it (`DeviceServices.tempo`). Omitted, a
   *  fixed 120 bpm stand-in is used — enough for every device that ignores
   *  tempo, and for tests that do not care. */
  tempo?: DeviceTempo | undefined;
  /** Injectable `setTimeout` for the deferred port teardown (tests). */
  schedule?: DelayedCall | undefined;
  /** Extra wait after `dispose(when)` before port nodes are disconnected. */
  teardownRampMs?: number | undefined;
}

const defaultSchedule: DelayedCall = (cb, ms) => {
  setTimeout(cb, ms);
};

/** `DeviceHost` plus the enumeration the mixer reconciler wants. */
export interface AppDeviceHost extends DeviceHost {
  list(): readonly MountedDevice[];
  /** Disposes one instance by id; `false` when nothing was mounted under it. */
  unmount(instanceId: DeviceInstanceId, when?: Seconds): boolean;
}

export function createDeviceHost(
  ctx: BaseAudioContext,
  params: ParamRegistry,
  registry: DeviceRegistry,
  options: DeviceHostOptions = {},
): AppDeviceHost {
  const mounted = new Map<DeviceInstanceId, MountedDevice>();
  const services: DeviceServices = {
    tempo: options.tempo ?? {
      secondsPerBeat: () => 0.5, // 120 bpm
      onChange: () => () => undefined,
    },
  };
  const schedule = options.schedule ?? defaultSchedule;
  const teardownRampMs = options.teardownRampMs ?? DEFAULT_RAMP_OUT_MS;
  let hostDisposed = false;

  function unregisterAll(ids: readonly ParamId[]): void {
    for (const id of ids) params.unregister(id);
  }

  function buildMounted(
    definition: DeviceDefinition,
    instanceId: DeviceInstanceId,
    channelId: string,
    instance: DeviceInstance,
    bundle: DeviceIOBundle,
    handles: Map<string, ParamHandle>,
    paramIds: Map<string, ParamId>,
  ): MountedDevice {
    let disposed = false;
    const device: MountedDevice = {
      id: instanceId,
      channelId,
      definition,
      instance,
      io: bundle.io,
      input: bundle.io.in,
      output: bundle.io.out,
      params: handles,
      paramId(localId: string): ParamId | undefined {
        return paramIds.get(localId);
      },
      dispose(when?: Seconds): void {
        if (disposed) return;
        disposed = true;
        mounted.delete(instanceId);
        // Params first: unregistering unbinds every handle, so neither a knob
        // nor an automation lane can write into the node that is fading out.
        unregisterAll([...paramIds.values()]);
        instance.dispose(when);
        // The ports outlive the instance's own fade by design — disconnecting
        // them at `when` would cut the tail the fade exists to preserve.
        //
        // `portWaitMs` takes the max with the harness's own fade budget
        // (`deviceTeardownWaitMs`) rather than trusting `teardownRampMs * 2`
        // to be the larger number: with the defaults those are 40 ms and
        // 50 ms, i.e. the ports were being cut BEFORE the device had finished
        // fading — the un-ramped click SS7's "gain-ramped" removal exists to
        // prevent. And the timer is audio-clock checked, so a suspended or
        // offline context does not get its ports cut before the fade ran.
        const now = ctx.currentTime;
        const at = when !== undefined && Number.isFinite(when) && when > now ? when : now;
        const portWaitMs = Math.max(
          teardownRampMs * 2,
          deviceTeardownWaitMs() + teardownRampMs,
        );
        runAfterAudioTime(
          ctx,
          at + portWaitMs / 1000,
          Math.max(0, (at - now) * 1000) + portWaitMs,
          schedule,
          () => {
            bundle.dispose();
          },
        );
      },
    };
    return device;
  }

  return {
    context: ctx,
    registry,

    async mount(mountOptions: MountDeviceOptions): Promise<MountedDevice> {
      if (hostDisposed) {
        throw new Error("DeviceHost.mount: host is disposed");
      }
      const { definition, instanceId, channelId } = mountOptions;
      if (mounted.has(instanceId)) {
        throw new Error(`DeviceHost.mount: instance "${instanceId}" is already mounted`);
      }

      // 1. prepare — once per context, before the first `create` on it.
      await prepareDefinition(ctx, definition);
      if (hostDisposed) {
        throw new Error("DeviceHost.mount: host was disposed while preparing");
      }
      if (mounted.has(instanceId)) {
        throw new Error(`DeviceHost.mount: instance "${instanceId}" is already mounted`);
      }

      // 2. create — the harness owns the ports, the device owns its nodes.
      const bundle = createDeviceIO(ctx, definition);
      let instance: DeviceInstance;
      try {
        instance = definition.create(ctx, bundle.io, services);
      } catch (error) {
        bundle.dispose();
        throw error;
      }

      // 3. register each descriptor under its full ParamId, then 4. bind it.
      const handles = new Map<string, ParamHandle>();
      const paramIds = new Map<string, ParamId>();
      try {
        for (const desc of definition.params) {
          const qualified = qualifyDescriptor(desc, { channelId, instanceId });
          const handle = params.register(qualified);
          handles.set(desc.id, handle);
          paramIds.set(desc.id, qualified.id);
        }
        for (const [localId, handle] of handles) {
          instance.connectParam(localId, handle);
        }
      } catch (error) {
        unregisterAll([...paramIds.values()]);
        instance.dispose();
        bundle.dispose();
        throw error;
      }

      const device = buildMounted(
        definition,
        instanceId,
        channelId,
        instance,
        bundle,
        handles,
        paramIds,
      );
      mounted.set(instanceId, device);
      return device;
    },

    get(instanceId: DeviceInstanceId): MountedDevice | undefined {
      return mounted.get(instanceId);
    },

    list(): readonly MountedDevice[] {
      return [...mounted.values()];
    },

    unmount(instanceId: DeviceInstanceId, when?: Seconds): boolean {
      const device = mounted.get(instanceId);
      if (device === undefined) return false;
      device.dispose(when);
      return true;
    },

    dispose(): void {
      if (hostDisposed) return;
      hostDisposed = true;
      for (const device of [...mounted.values()]) device.dispose();
      mounted.clear();
    },
  };
}

/** Compile-time conformance with the frozen factory signature (SS7). */
export const createHost: CreateDeviceHost = createDeviceHost;
