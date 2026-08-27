// types/engine.ts `ProjectEngine`, M2 edition: the coarse M1 body of
// `applyDocument` ("re-derive the whole desired instrument set") is replaced
// by the SS6 reconciler — `buildGraph(doc)` -> `diff(live, desired)` ->
// patch — behind the SAME signature, exactly as the M1 comment promised.
//
// The engine owns what the reconciler must not know about: the transport and
// its note-event source, note TARGETS (track -> mounted instrument), the
// param registry's document loads, and the SS6 meter bus (strip taps follow
// the reconciler's post-fader nodes after every apply).

import { CORE_DEVICES } from "../../devices/core";
import {
  createDeviceHost,
  createDeviceRegistry,
  type AppDeviceHost,
  type AppDeviceRegistry,
} from "../../devices/harness";
import { createAutomationSampler, type AutomationSampler } from "../../engine/automation/sampler";
import { createGraphReconciler, type GraphReconciler } from "../../engine/graph/reconciler";
import { createMeterBus, type MeterBus } from "../../engine/meter/meters";
import { createEngineTransport, type Clock, type EngineTransport } from "../../engine/transport";
import { createParamRegistry, type AppParamRegistry } from "../../params";
import { createTempoMap } from "../../time";
import type { ParamCommit } from "../../params";
import type {
  AuditionSink,
  ChannelId,
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
  /** Overrides the reconciler's dip-phase decision (tests/offline). */
  immediateReconcile?: boolean | undefined;
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
  /** SS6 metering: per-strip peak/RMS frames, read by the mixer UI at rAF. */
  readonly meters: MeterBus;
  /** SS11 automation: the app's playhead loop calls `updateDisplay` so
   *  moving knobs track the lanes; scheduling itself rides the transport's
   *  window filler and needs nothing from the UI. */
  readonly automation: AutomationSampler;
}

/** The transport's per-track note target — rebuilt per apply, looked up per
 *  tick without allocating (SS12). */
interface TrackTarget {
  readonly noteTarget: NoteTarget;
}

/** `undefined` unless every one of the three note methods is present — a
 *  device wired to a track's `source` should always be an instrument, but a
 *  mis-registered definition must not crash playback, only stay silent. */
function noteTargetOf(mounted: MountedDevice): NoteTarget | undefined {
  const { noteOn, noteOff, allNotesOff } = mounted.instance;
  if (noteOn === undefined || noteOff === undefined || allNotesOff === undefined) return undefined;
  return { noteOn, noteOff, allNotesOff };
}

/**
 * Builds the engine against ANY `BaseAudioContext` (SS12: the same wiring
 * drives a live `AudioContext` and an `OfflineAudioContext` render),
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

  // Dip-phase ramps only make sense against a live, wall-clocked context.
  const live = typeof AudioContext !== "undefined" && ctx instanceof AudioContext;
  const reconciler: GraphReconciler = createGraphReconciler({
    ctx,
    destination,
    host,
    params,
    immediate: options.immediateReconcile ?? !live,
  });
  const meters: MeterBus = createMeterBus(ctx);

  // SS11: the sampler attaches to the transport's window-filler seam below
  // and follows the document's enabled lanes on every apply.
  let currentTempoMap = createTempoMap(initialDoc.tempo);
  const automation: AutomationSampler = createAutomationSampler({
    registry: params,
    tempoMap: () => currentTempoMap,
    isMessageBound: (id) => params.bindingKind(id) === "message",
  });

  const targetsByChannel = new Map<ChannelId, TrackTarget>();
  const meteredChannels = new Set<ChannelId>();
  const events = createDocumentNoteEventSource(initialDoc);

  const transport: EngineTransport = createEngineTransport({
    context: ctx,
    tempoMap: createTempoMap(initialDoc.tempo),
    events,
    resolveTarget: (trackId) => targetsByChannel.get(trackId)?.noteTarget,
    loop: initialDoc.loop,
    lookAheadSeconds: options.lookAheadSeconds,
    tickIntervalMs: options.tickIntervalMs,
    clock: options.clock,
  });

  let disposed = false;
  // Serializes `applyDocument`: mounting awaits `prepare()` (worklet loading),
  // so two edits landing in the same tick must not race two overlapping
  // reconciles.
  let queue: Promise<void> = Promise.resolve();

  async function applyNow(doc: ProjectSnapshot): Promise<void> {
    if (disposed) return;
    currentTempoMap = createTempoMap(doc.tempo);
    transport.setTempoMap(currentTempoMap);
    transport.setLoop(doc.loop);

    // SS6: document -> desired graph -> diff -> patched live graph.
    await reconciler.apply(doc);
    if (disposed) return;

    // Note targets: each track's source instrument, freshly resolved (a swap
    // remounted the device; same map, new instance).
    targetsByChannel.clear();
    for (const channelId of doc.channelOrder) {
      const channel = doc.channels[channelId];
      if (channel === undefined || channel.role !== "track") continue;
      const source = channel.source;
      if (source === null || source.kind !== "instrument") continue;
      const mounted = reconciler.mountedDevice(source.deviceId);
      if (mounted === undefined) continue;
      const noteTarget = noteTargetOf(mounted);
      if (noteTarget !== undefined) targetsByChannel.set(channelId, { noteTarget });
    }

    // Meter taps follow the reconciler's post-fader nodes (SS6 meter tap).
    const wantMeters = new Set<ChannelId>();
    for (const channelId of doc.channelOrder) {
      const tap = reconciler.meterTapFor(channelId);
      if (tap === undefined) continue;
      wantMeters.add(channelId);
      meters.attach(channelId, tap);
    }
    for (const channelId of [...meteredChannels]) {
      if (!wantMeters.has(channelId)) meters.detach(channelId);
    }
    meteredChannels.clear();
    for (const channelId of wantMeters) meteredChannels.add(channelId);

    // SS11: lanes -> sampler -> the registry's automated set. Lanes whose
    // param is not registered (device unmounted, param renamed) simply match
    // no handle — they are the SS7 "kept, greyed" lanes.
    automation.setLanes(Object.values(doc.lanes));
    params.setAutomatedIds(automation.automatedIds());

    // `events.setDocument` must run even when nothing rewired: the whole
    // point of the delegating source is making a note edit audible without a
    // transport rebuild.
    events.setDocument(doc);
    // Reloads every value, not just what changed: a device or mixer strip
    // mounted just above starts at descriptor defaults and needs the
    // document's saved value backfilled in (SS4 `load` contract).
    params.load(doc.paramValues);
  }

  transport.addWindowFiller(automation);

  return {
    transport,
    params,
    meters,
    automation,
    onParamCommit(cb: (commit: ParamCommit) => void): Unsub {
      return params.onCommit(cb);
    },
    applyDocument(doc: ProjectSnapshot): Promise<void> {
      queue = queue.then(() => applyNow(doc));
      return queue;
    },
    auditionFor(channelId: ChannelId): AuditionSink | undefined {
      const target = targetsByChannel.get(channelId)?.noteTarget;
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
      meters.dispose();
      reconciler.dispose();
      host.dispose();
      params.dispose();
    },
  };
}
