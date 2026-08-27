// types/engine.ts `ProjectEngine` — "the engine as the app shell holds it in
// M1: one transport, one param registry, one instrument per track, and a way
// to hand it a new document."
//
// `applyDocument` is deliberately coarse (per the interface's own doc
// comment): every call re-derives the whole desired instrument set from the
// document, mounts what is missing, unmounts what no longer matches, re-points
// the transport's event source and reloads every param value. No diffing
// beyond "is this channel's instrument still the same device" — M2's
// reconciler is what replaces this body with a real `diff(live, desired)`,
// behind the same signature.
//
// Effects chains and routing (`Channel.chain`, `output`, `sends`,
// `sidechains`) are NOT wired here: M1 has no mixer yet (SS18-M1 proves the
// editor kit, command/undo and persistence, not routing), so every mounted
// instrument connects straight to `destination`. M2 owns the graph.

import { CORE_DEVICES } from "../../devices/core";
import {
  createDeviceHost,
  createDeviceRegistry,
  type AppDeviceHost,
  type AppDeviceRegistry,
} from "../../devices/harness";
import { createEngineTransport, type Clock, type EngineTransport } from "../../engine/transport";
import { createParamRegistry, type AppParamRegistry } from "../../params";
import { createTempoMap } from "../../time";
import type { ParamCommit } from "../../params";
import type {
  AuditionSink,
  ChannelId,
  DeviceDefinitionId,
  DeviceInstanceId,
  MountedDevice,
  NoteTarget,
  ProjectEngine,
  ProjectSnapshot,
  Seconds,
  Unsub,
} from "../../types";
import { createDocumentNoteEventSource } from "./documentEventSource";

export interface ProjectEngineOptions {
  lookAheadSeconds?: Seconds | undefined;
  tickIntervalMs?: number | undefined;
  /** Injectable clock — tests use a `ManualClock` (`../../engine/transport`);
   *  the live app leaves this unset and gets the real worker/timer clock. */
  clock?: Clock | undefined;
}

/**
 * `ProjectEngine` plus the wider `EngineTransport` the app shell's own
 * diagnostics and tests want (`clockKind`, `droppedTicks`) — additive, same
 * pattern as `AppDocumentStore`/`AppParamRegistry`: an `AppProjectEngine` is
 * a `ProjectEngine` anywhere one is asked for.
 */
export interface AppProjectEngine extends ProjectEngine {
  readonly transport: EngineTransport;
  /** Widened so the app shell can hand it straight to
   *  `connectParamRegistry` (SS3/SS13's PARAM COMMITS wiring) without a
   *  cast — `AppParamRegistry` is a `ParamRegistry` anywhere one is asked
   *  for, same pattern as `AppDocumentStore`. */
  readonly params: AppParamRegistry;
  /** Gesture-end commits, straight off the registry (SS3/SS13) — a
   *  diagnostics convenience, not a second write path: the document layer
   *  already gets these through `connectParamRegistry`. */
  onParamCommit(cb: (commit: ParamCommit) => void): Unsub;
}

interface TrackMount {
  readonly channelId: ChannelId;
  readonly deviceId: DeviceInstanceId;
  readonly definitionId: DeviceDefinitionId;
  readonly mounted: MountedDevice;
  /** Built once at mount time (not per resolveTarget/audition call) so the
   *  transport's per-tick `resolveTarget` lookup never allocates (SS12). */
  readonly noteTarget: NoteTarget | undefined;
}

interface DesiredInstrument {
  readonly deviceId: DeviceInstanceId;
  readonly definitionId: DeviceDefinitionId;
}

/** `undefined` unless every one of the three note methods is present — a
 *  device wired to a track's `source` should always be an instrument, but a
 *  mis-registered definition must not crash playback, only stay silent. */
function noteTargetOf(mounted: MountedDevice): NoteTarget | undefined {
  const { noteOn, noteOff, allNotesOff } = mounted.instance;
  if (noteOn === undefined || noteOff === undefined || allNotesOff === undefined) return undefined;
  return { noteOn, noteOff, allNotesOff };
}

function desiredInstruments(doc: ProjectSnapshot): Map<ChannelId, DesiredInstrument> {
  const out = new Map<ChannelId, DesiredInstrument>();
  for (const channelId of doc.channelOrder) {
    const channel = doc.channels[channelId];
    if (channel === undefined || channel.role !== "track") continue;
    const source = channel.source;
    if (source === null || source.kind !== "instrument") continue;
    const device = doc.devices[source.deviceId];
    if (device === undefined) continue;
    out.set(channelId, { deviceId: device.id, definitionId: device.definitionId });
  }
  return out;
}

/**
 * Builds the M1 engine against ANY `BaseAudioContext` (SS12: the same
 * wiring drives a live `AudioContext` and an `OfflineAudioContext` render),
 * starting from whatever document the app shell hands it.
 */
export function createProjectEngine(
  ctx: BaseAudioContext,
  destination: AudioNode,
  initialDoc: ProjectSnapshot,
  options: ProjectEngineOptions = {},
): AppProjectEngine {
  const params: AppParamRegistry = createParamRegistry({ now: () => ctx.currentTime });
  const registry: AppDeviceRegistry = createDeviceRegistry(CORE_DEVICES);
  const host: AppDeviceHost = createDeviceHost(ctx, params, registry);

  const mountedByChannel = new Map<ChannelId, TrackMount>();
  const events = createDocumentNoteEventSource(initialDoc);

  const transport: EngineTransport = createEngineTransport({
    context: ctx,
    tempoMap: createTempoMap(initialDoc.tempo),
    events,
    resolveTarget: (trackId) => mountedByChannel.get(trackId)?.noteTarget,
    loop: initialDoc.loop,
    lookAheadSeconds: options.lookAheadSeconds,
    tickIntervalMs: options.tickIntervalMs,
    clock: options.clock,
  });

  let disposed = false;
  // Serializes `applyDocument`: mounting awaits `prepare()` (worklet loading),
  // so two edits landing in the same tick must not race two overlapping
  // mounts/unmounts of the same channel's instrument.
  let queue: Promise<void> = Promise.resolve();

  async function applyNow(doc: ProjectSnapshot): Promise<void> {
    if (disposed) return;
    transport.setTempoMap(createTempoMap(doc.tempo));
    transport.setLoop(doc.loop);

    const desired = desiredInstruments(doc);

    for (const [channelId, mount] of [...mountedByChannel]) {
      const want = desired.get(channelId);
      if (want === undefined || want.deviceId !== mount.deviceId || want.definitionId !== mount.definitionId) {
        host.unmount(mount.deviceId);
        mountedByChannel.delete(channelId);
      }
    }

    for (const [channelId, want] of desired) {
      if (mountedByChannel.has(channelId)) continue;
      const definition = registry.get(want.definitionId);
      if (definition === undefined) continue; // unknown definition id: coarse M1 skip, stays silent
      const mounted = await host.mount({ definition, instanceId: want.deviceId, channelId });
      if (disposed) {
        mounted.dispose();
        return;
      }
      mounted.output.connect(destination);
      mountedByChannel.set(channelId, {
        channelId,
        deviceId: want.deviceId,
        definitionId: want.definitionId,
        mounted,
        noteTarget: noteTargetOf(mounted),
      });
    }

    // `events.setDocument` must run even when nothing (re)mounted: the whole
    // point of the delegating source is making a note edit audible without a
    // transport rebuild.
    events.setDocument(doc);
    // Reloads every value, not just what changed: a device mounted just above
    // starts at its descriptor defaults and needs the document's saved value
    // backfilled in (SS4 `load` contract) — see `applyParamValues`'s doc
    // comment in ../../state/paramBridge.ts.
    params.load(doc.paramValues);
  }

  return {
    transport,
    params,
    onParamCommit(cb: (commit: ParamCommit) => void): Unsub {
      return params.onCommit(cb);
    },
    applyDocument(doc: ProjectSnapshot): Promise<void> {
      queue = queue.then(() => applyNow(doc));
      return queue;
    },
    auditionFor(channelId: ChannelId): AuditionSink | undefined {
      const target = mountedByChannel.get(channelId)?.noteTarget;
      if (target === undefined) return undefined;
      // SS10: "Auditions are UI, not transport: they play immediately and are
      // never scheduled" — `ctx.currentTime` read at call time, not queued.
      return {
        noteOn(pitch: number, vel: number): void {
          target.noteOn(pitch, vel, ctx.currentTime);
        },
        noteOff(pitch: number): void {
          target.noteOff(pitch, ctx.currentTime);
        },
        allNotesOff(): void {
          target.allNotesOff(ctx.currentTime);
        },
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      transport.dispose();
      host.dispose();
      params.dispose();
    },
  };
}
