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
import { createAssetLibrary, type AppAssetLibrary } from "../../engine/assets/library";
import {
  createAudioClipScheduler,
  type AudioClipScheduler,
} from "../../engine/audioclips/scheduler";
import { createAutomationSampler, type AutomationSampler } from "../../engine/automation/sampler";
import { createGraphReconciler, type GraphReconciler } from "../../engine/graph/reconciler";
import { createMeterBus, type MeterBus } from "../../engine/meter/meters";
import {
  buildNoteChain,
  createNoteChainRunner,
  type ChannelNoteChain,
  type NoteChainRunner,
} from "../../engine/notes/noteChain";
import { createEngineTransport, type Clock, type EngineTransport } from "../../engine/transport";
import { createParamRegistry, type AppParamRegistry } from "../../params";
import { createTempoMap } from "../../time";
import type { ParamCommit } from "../../params";
import type {
  AuditionSink,
  ChannelId,
  DeviceInstance,
  DeviceInstanceId,
  MountedDevice,
  NoteTarget,
  ProjectEngine,
  ProjectSnapshot,
  Seconds,
  TempoSegment,
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
  /**
   * A reconcile that threw — a worklet module that would not load, a device
   * `create()` that failed. `applyDocument` always RESOLVES (see its
   * implementation), so this is the only way the failure is visible; the app
   * shell renders it in the toolbar's status line. Nothing else changes: the
   * next document change reconciles again, which is what makes the retry
   * `prepareDefinition` deliberately allows reachable.
   */
  onApplyError(cb: (error: unknown) => void): Unsub;
  /**
   * Current value of a mounted device's SS5 readout (`DeviceReadoutSpec`),
   * in its own real units — the compressor's gain reduction, and whatever
   * follows it. `undefined` when the device is not mounted or publishes no
   * such id, which is also what the panel gets before the engine boots.
   *
   * UI-only, like the meters: polled at rAF, never in the document.
   */
  deviceReadout(deviceId: DeviceInstanceId, readoutId: string): number | undefined;
  /**
   * An `AnalyserNode` tapped off a channel's POST-FADER node — the same tap
   * the SS6 meters read, so a visualiser shows exactly what the strip's meter
   * is measuring and what the master bus is sending out.
   *
   * Created on demand and cached per channel, and re-connected after every
   * apply (the post-fader node is rebuilt whenever the graph is). `null`
   * when the channel is not in the graph, or when the context has no
   * `createAnalyser` (the test fakes) — a visualiser then simply draws
   * nothing, which is the honest picture of "no audio here".
   */
  analyserFor(channelId: ChannelId): AnalyserNode | null;
  /**
   * Decoded imported audio (SS7 `DeviceServices.assets`), as the SHELL sees
   * it: the shell reads bytes out of storage and pushes them in here, and the
   * device host hands the same library to every device.
   */
  readonly assets: AppAssetLibrary;
  /**
   * An `AnalyserNode` on a mounted device's OUTPUT port — what the device is
   * putting out, as opposed to `analyserFor`'s whole-channel tap. The EQ
   * draws its own spectrum from this; nothing else needs it yet.
   *
   * Same lifecycle as `analyserFor`: created on demand, cached, re-connected
   * after every apply, `null` when the device is not mounted (or the context
   * has no `createAnalyser`).
   */
  deviceAnalyser(deviceId: DeviceInstanceId): AnalyserNode | null;
  /**
   * Runs one free-running note-effect window (see `NoteChainRunner`). The
   * shell calls it at rAF while the transport is stopped, which is what makes
   * an arpeggiator answer the keyboard with nothing playing. A no-op while
   * playing, and while no channel has a note effect.
   */
  pumpNotes(): void;
  /** Whether any channel has a note effect — the shell uses it to decide
   *  whether the free-run rAF above is worth starting at all. */
  hasNoteEffects(): boolean;
}

/**
 * FFT size for the visualiser taps. 2048 bins at 48 kHz is ~23 Hz per bin —
 * fine enough to separate the harmonics of a bass note, coarse enough that
 * one `getByteFrequencyData` per frame is nothing.
 */
export const ANALYSER_FFT_SIZE = 2048;

/** The transport's per-track note target — rebuilt per apply, looked up per
 *  tick without allocating (SS12). With a `midiChain` on the channel this is
 *  the HEAD of that chain rather than the instrument itself; everything
 *  upstream (transport, audition, keyboard) is unaffected either way. */
interface TrackTarget {
  readonly noteTarget: NoteTarget;
}

/**
 * Segment-wise equality over the document's tempo (SS8 data, not the built
 * map). `EngineTransport.setTempoMap` PANICS whenever the transport is not
 * stopped — every pending note-on gets a note-off at its own onset, every
 * track that has played gets an `allNotesOff`, and the look-ahead cursor
 * re-anchors — so pushing a map that did not actually change would cut every
 * sounding voice on EVERY edit made during playback (a note drag, a knob
 * release, an automation point move all reach `applyDocument`). That is SS2's
 * glitch-free-audio budget blown on the most common interaction in the app,
 * so the map is pushed only when the segments really differ.
 */
function sameTempoSegments(a: readonly TempoSegment[], b: readonly TempoSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startTick !== b[i]!.startTick || a[i]!.bpm !== b[i]!.bpm) return false;
  }
  return true;
}

/** `undefined` unless every one of the three note methods is present — a
 *  device wired to a track's `source` should always be an instrument, but a
 *  mis-registered definition must not crash playback, only stay silent. */
/**
 * The note target for a mounted instrument, or `undefined` if it is not one.
 *
 * Only `noteOn` is required. A PERCUSSION instrument has no note-off to
 * honour — a kick rings for its decay whether or not the key is still down —
 * and demanding all three made such a device silently unplayable: it
 * registered its params, drew its panel, took notes in the piano roll, and
 * produced nothing, with no error anywhere. Filling the two optional halves
 * with no-ops keeps the transport's contract (it calls all three, including
 * at a loop boundary) without making silence the default for a whole class
 * of instrument.
 */
function noteTargetOf(mounted: MountedDevice): NoteTarget | undefined {
  const { noteOn, noteOff, allNotesOff } = mounted.instance;
  if (noteOn === undefined) return undefined;
  return {
    noteOn,
    noteOff: noteOff ?? ((): void => undefined),
    allNotesOff: allNotesOff ?? ((): void => undefined),
  };
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
  // SS8 tempo, as a DEVICE may see it: one number (how long a beat is) plus a
  // change notification, so a tempo-synced delay or LFO can convert a note
  // LENGTH without being able to see the transport or the song position.
  const tempoListeners = new Set<() => void>();
  const assets: AppAssetLibrary = createAssetLibrary(ctx);
  const host: AppDeviceHost = createDeviceHost(ctx, params, registry, {
    assets,
    tempo: {
      secondsPerBeat: () => 60 / currentTempoMap.bpmAt(0),
      onChange: (cb) => {
        tempoListeners.add(cb);
        return () => tempoListeners.delete(cb);
      },
    },
  });

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

  // The tempo map the transport and the sampler are currently running, plus
  // the document segments it was built from (see `sameTempoSegments`).
  let currentTempoSegments: readonly TempoSegment[] = initialDoc.tempo;
  let currentTempoMap = createTempoMap(initialDoc.tempo);

  // SS11: the sampler attaches to the transport's window-filler seam below
  // and follows the document's enabled lanes on every apply.
  const automation: AutomationSampler = createAutomationSampler({
    registry: params,
    tempoMap: () => currentTempoMap,
    isMessageBound: (id) => params.bindingKind(id) === "message",
  });

  /** SS10's audio clips: the second thing on the timeline that has to be
   *  scheduled into the transport's look-ahead window. Registered beside the
   *  automation sampler, below. */
  let currentDoc: ProjectSnapshot = initialDoc;
  const audioClips: AudioClipScheduler = createAudioClipScheduler({
    ctx,
    doc: () => currentDoc,
    tempoMap: () => currentTempoMap,
    assets,
    inputFor: (channelId) => reconciler.inputFor(channelId),
  });

  /** SS7 note effects: the chains sit between the transport and the
   *  instruments, and are pumped once per look-ahead window (and at rAF while
   *  stopped, through `pumpNotes`). */
  const noteChains: NoteChainRunner = createNoteChainRunner({
    ctx,
    tempoMap: () => currentTempoMap,
  });

  const targetsByChannel = new Map<ChannelId, TrackTarget>();
  const meteredChannels = new Set<ChannelId>();
  /** Visualiser taps, created lazily by `analyserFor` and re-connected on
   *  every apply. One per channel anyone is actually looking at. */
  const analysers = new Map<ChannelId, AnalyserNode>();
  /** The same, per DEVICE output (`deviceAnalyser`). */
  const deviceAnalysers = new Map<DeviceInstanceId, AnalyserNode>();
  const events = createDocumentNoteEventSource(initialDoc);

  const transport: EngineTransport = createEngineTransport({
    context: ctx,
    tempoMap: currentTempoMap,
    events,
    resolveTarget: (trackId) => targetsByChannel.get(trackId)?.noteTarget,
    loop: initialDoc.loop,
    lookAheadSeconds: options.lookAheadSeconds,
    tickIntervalMs: options.tickIntervalMs,
    clock: options.clock,
  });

  let disposed = false;
  const applyErrorListeners = new Set<(error: unknown) => void>();
  // Serializes `applyDocument`: mounting awaits `prepare()` (worklet loading),
  // so two edits landing in the same tick must not race two overlapping
  // reconciles.
  let queue: Promise<void> = Promise.resolve();

  async function applyNow(doc: ProjectSnapshot): Promise<void> {
    if (disposed) return;
    if (!sameTempoSegments(doc.tempo, currentTempoSegments)) {
      currentTempoSegments = doc.tempo;
      currentTempoMap = createTempoMap(doc.tempo);
      transport.setTempoMap(currentTempoMap);
      // Tempo-synced devices re-derive their times from the new beat length.
      for (const cb of [...tempoListeners]) cb();
    }
    // `setLoop` only swaps a field (it takes effect from the next window), so
    // it needs no such guard.
    transport.setLoop(doc.loop);

    // SS6: document -> desired graph -> diff -> patched live graph.
    await reconciler.apply(doc);
    if (disposed) return;

    // BEFORE the lanes below: `setBase` writes through to the DSP only while
    // a param is `free` (SS4's state machine), so a param an enabled lane is
    // about to mark `automated` has exactly this one moment to receive the
    // document's saved value. Loading after `setAutomatedIds` left every
    // automated device/mixer param sitting at its descriptor default in the
    // graph while the strip showed the saved one.
    //
    // Reloads every value, not just what changed: a device or mixer strip
    // mounted just above starts at descriptor defaults and needs the
    // document's saved value backfilled in (SS4 `load` contract).
    params.load(doc.paramValues);

    // Note targets: each track's source instrument, freshly resolved (a swap
    // remounted the device; same map, new instance), with the channel's note
    // effects wired in front of it.
    //
    // Rebuilt wholesale on every apply, like the meter taps: the wrapper
    // objects are cheap, and the DEVICES they wrap are the same instances
    // across applies (the reconciler only remounts what actually changed), so
    // an arpeggiator keeps the chord it is holding through an unrelated edit.
    targetsByChannel.clear();
    const chains: ChannelNoteChain[] = [];
    for (const channelId of doc.channelOrder) {
      const channel = doc.channels[channelId];
      if (channel === undefined || channel.role !== "track") continue;
      const source = channel.source;
      if (source === null || source.kind !== "instrument") continue;
      const mounted = reconciler.mountedDevice(source.deviceId);
      if (mounted === undefined) continue;
      const instrument = noteTargetOf(mounted);
      if (instrument === undefined) continue;
      const effects: DeviceInstance[] = [];
      for (const deviceId of channel.midiChain ?? []) {
        const device = doc.devices[deviceId];
        // A DISABLED note effect is bypassed, exactly as a disabled audio
        // effect is dropped out of the signal path: it stays mounted, keeps
        // its params, and the notes route around it.
        if (device === undefined || !device.enabled) continue;
        const effect = reconciler.mountedDevice(deviceId)?.instance;
        if (effect !== undefined) effects.push(effect);
      }
      const chain = buildNoteChain(channelId, effects, instrument);
      chains.push(chain);
      targetsByChannel.set(channelId, { noteTarget: chain.head });
    }
    noteChains.setChains(chains);

    // Device analyser taps follow their device's output port, which is a new
    // node whenever the device was remounted.
    for (const [deviceId, analyser] of deviceAnalysers) {
      analyser.disconnect();
      const output = reconciler.mountedDevice(deviceId)?.output;
      if (output === undefined) continue;
      try {
        output.connect(analyser);
      } catch {
        // Same as the channel taps below: the next apply re-runs this.
      }
    }

    // Analyser taps follow the same post-fader nodes the meters do. Only
    // channels something has actually ASKED to analyse are re-connected: an
    // AnalyserNode per strip would be an FFT per strip whether or not anyone
    // is looking (SS2's audio budget), so these are created lazily and kept
    // only while a visualiser holds one.
    for (const [channelId, analyser] of analysers) {
      const tap = reconciler.meterTapFor(channelId);
      analyser.disconnect();
      if (tap === undefined) continue;
      try {
        tap.connect(analyser);
      } catch {
        // A tap that vanished between the lookup and the connect: the next
        // apply re-runs this, and the visualiser draws a flat line until then.
      }
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
    // transport rebuild. It reports whether the note material actually
    // changed — only then does the transport re-anchor, because the new scan
    // will not emit note-offs for notes the OLD one started (see
    // `Transport.notesChanged`), and a param edit must not cut held notes.
    currentDoc = doc;
    if (events.setDocument(doc)) transport.notesChanged();
  }

  transport.addWindowFiller(automation);
  // After the automation sampler, deliberately: a note effect reads its own
  // params as plain values when it generates, so it should see the values
  // this window's automation has just written rather than the previous
  // window's.
  transport.addWindowFiller(noteChains);
  transport.addWindowFiller(audioClips);
  // A stopped transport must not leave a take playing over silence; the
  // scheduler also treats the stop as a discontinuity, so the next play does
  // not read as a continuation of the window before it.
  transport.onStateChange((state) => {
    const stopped = state === "stopped";
    if (stopped) audioClips.stopAll(ctx.currentTime);
    // Handing the free run over to the transport (and back) is a
    // discontinuity for a note effect the same way a seek is for the clip
    // scanner: whatever it was holding belongs to the pass that just ended.
    noteChains.releaseAll(ctx.currentTime);
    noteChains.setPlaying(!stopped);
  });

  return {
    transport,
    params,
    meters,
    automation,
    onParamCommit(cb: (commit: ParamCommit) => void): Unsub {
      return params.onCommit(cb);
    },
    deviceReadout(deviceId: DeviceInstanceId, readoutId: string): number | undefined {
      return reconciler.mountedDevice(deviceId)?.instance.readValue?.(readoutId);
    },

    assets,

    pumpNotes(): void {
      noteChains.pumpFree();
    },

    hasNoteEffects(): boolean {
      return noteChains.hasEffects();
    },

    deviceAnalyser(deviceId: DeviceInstanceId): AnalyserNode | null {
      const existing = deviceAnalysers.get(deviceId);
      if (existing !== undefined) return existing;
      const output = reconciler.mountedDevice(deviceId)?.output;
      if (output === undefined) return null;
      const create = (ctx as { createAnalyser?: () => AnalyserNode }).createAnalyser;
      if (typeof create !== "function") return null;
      const analyser = create.call(ctx);
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0.7;
      deviceAnalysers.set(deviceId, analyser);
      output.connect(analyser);
      return analyser;
    },

    analyserFor(channelId: ChannelId): AnalyserNode | null {
      const existing = analysers.get(channelId);
      if (existing !== undefined) return existing;
      const create = (ctx as { createAnalyser?: () => AnalyserNode }).createAnalyser;
      if (typeof create !== "function") return null;
      const analyser = create.call(ctx);
      analyser.fftSize = ANALYSER_FFT_SIZE;
      // Slower than the default 0.8: the eye reads a spectrum as a shape, and
      // an unsmoothed FFT of music is a flickering comb rather than a shape.
      analyser.smoothingTimeConstant = 0.7;
      analysers.set(channelId, analyser);
      const tap = reconciler.meterTapFor(channelId);
      if (tap !== undefined) tap.connect(analyser);
      return analyser;
    },

    onApplyError(cb: (error: unknown) => void): Unsub {
      applyErrorListeners.add(cb);
      return () => {
        applyErrorListeners.delete(cb);
      };
    },
    applyDocument(doc: ProjectSnapshot): Promise<void> {
      // The chain must ALWAYS resolve. `queue` is the serialization point for
      // every apply of the session, so a single rejection left in it (one
      // worklet module that would not load) poisoned it permanently: every
      // later `.then` was skipped and the engine silently stopped following
      // the document — no reconcile, no `events.setDocument`, no param load —
      // while the UI happily showed the edits.
      queue = queue.then(() => applyNow(doc)).catch((error: unknown) => {
        for (const cb of [...applyErrorListeners]) cb(error);
      });
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
      for (const analyser of analysers.values()) analyser.disconnect();
      analysers.clear();
      for (const analyser of deviceAnalysers.values()) analyser.disconnect();
      deviceAnalysers.clear();
      audioClips.dispose();
      assets.dispose();
      reconciler.dispose();
      host.dispose();
      params.dispose();
      applyErrorListeners.clear();
    },
  };
}
