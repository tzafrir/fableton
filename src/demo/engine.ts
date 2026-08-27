// M0's audible proof (SS18-M0, SS15 "hard-coded chain synth -> filter ->
// destination"): wires a param registry, a device registry holding the core
// device library (SS7), a device host, the hard-coded clip's event source,
// and a transport into one chain — against ANY `BaseAudioContext` (SS12), so
// the exact same wiring drives both the live `App` (a real `AudioContext`)
// and the headless `OfflineAudioContext` render (`./offlineRender.ts`,
// SS15's "engine runs headless ... schedule a clip, render, assert on the
// buffer").

import type { ParamId, ParamRegistry, Seconds, Unsub } from "../types";
import { createParamRegistry, deviceParamId, type ParamCommit } from "../params";
import { createDeviceHost, createDeviceRegistry } from "../devices/harness";
import { createFixedTempoMap } from "../time";
import {
  createClipEventSource,
  createEngineTransport,
  type Clock,
  type EngineTransport,
} from "../engine/transport";
import { CORE_DEVICES } from "../devices/core";
import { DEMO_BPM, DEMO_CLIP, DEMO_TRACK_ID } from "./clip";
import { instrumentToNoteTarget } from "./noteTarget";

/** SS18-M0's "one poly synth + one filter effect as definitions" — looked up
 *  by id through the registry rather than imported into the chain directly,
 *  so the demo goes through the same SS7 "registered by id" path every later
 *  milestone's document loader will. */
const SYNTH_DEFINITION_ID = "core.poly-synth";
const FILTER_DEFINITION_ID = "core.filter";

const SYNTH_INSTANCE_ID = "demo-synth";
const FILTER_INSTANCE_ID = "demo-filter";

/** The filter's cutoff, under the SS4 id scheme the host registers it with.
 *  M0's UI drives this one param to prove fast path A end to end — gesture ->
 *  `setLive` -> `AudioParam` -> `commit` (SS3 "the two write paths"). */
export const DEMO_CUTOFF_PARAM_ID: ParamId = deviceParamId(
  DEMO_TRACK_ID,
  FILTER_INSTANCE_ID,
  "cutoff",
);

/** Output level for the demo instrument, in dB. See the headroom note in
 *  `createDemoEngine`. */
export const DEMO_SYNTH_GAIN_DB = -6;

/** The fixed tempo map every part of the demo (engine, offline render, its
 *  tests) shares — SS8: "v1 ships a single fixed-tempo segment." */
export const DEMO_TEMPO_MAP = createFixedTempoMap(DEMO_BPM);

/** How long the demo clip takes to play once through, tail included — the
 *  buffer length the offline render needs to capture every note's release. */
export function demoClipDurationSeconds(tailSeconds = 0.5): Seconds {
  return DEMO_TEMPO_MAP.secondsAt(DEMO_CLIP.length) + tailSeconds;
}

export interface CreateDemoEngineOptions {
  /** Injectable clock — tests and the offline render use a `ManualClock`
   *  (see `../engine/transport`); the live app leaves this unset and gets
   *  the real worker/timer clock. */
  clock?: Clock | undefined;
  lookAheadSeconds?: Seconds | undefined;
  tickIntervalMs?: number | undefined;
}

export interface DemoEngine {
  readonly transport: EngineTransport;
  /**
   * The SS4 registry every mounted device's params live in — the UI half of
   * the one sanctioned bridge (SS3/SS4). Lookups hand back a `ParamHandle`,
   * never a node or a raw setter, so a control can only reach the DSP through
   * `setLive` + `commit`.
   *
   * Deliberately the frozen `ParamRegistry`, not the app-side
   * `AppParamRegistry`: `load()` writes straight through `setBase` into the
   * bound `AudioParam`, which would be a third write path into the DSP,
   * invisible to `onCommit` (SS3: "there are exactly two ways anything changes
   * at runtime"). It belongs to the document layer, and the document layer
   * does not reach the engine through this handle.
   */
  readonly params: ParamRegistry;
  /** Gesture-end commits — where M1's command bus attaches (SS3/SS13). The
   *  read half of the bridge, kept separate from the UI-facing registry. */
  onParamCommit(cb: (commit: ParamCommit) => void): Unsub;
  /** Stops playback and releases every resource this engine created. */
  dispose(): void;
}

/**
 * Builds the M0 demo chain — `core.poly-synth -> core.filter ->
 * destination` (SS7: "M0's demo chain is two of [MountedDevice] connected
 * end to end") — and a transport playing `DEMO_CLIP` on `DEMO_TRACK_ID`.
 *
 * `destination` is whatever the caller wants terminating the chain:
 * `ctx.destination` for the live app, an `OfflineAudioContext`'s
 * destination for the render proof.
 */
export async function createDemoEngine(
  ctx: BaseAudioContext,
  destination: AudioNode,
  options: CreateDemoEngineOptions = {},
): Promise<DemoEngine> {
  // The ParamRegistry needs the audio clock to schedule its de-zipper ramps;
  // the context only exists here, at the wiring point (SS4 fast path A).
  const params = createParamRegistry({ now: () => ctx.currentTime });
  // SS7: "A device is a definition ... registered by id" — the core device
  // library is registered once, at boot, and mounted by id from here on.
  const registry = createDeviceRegistry(CORE_DEVICES);
  const host = createDeviceHost(ctx, params, registry);

  // SS7 lifecycle, twice: prepare -> create -> register params -> connectParam.
  const synth = await host.mount({
    definition: registry.require(SYNTH_DEFINITION_ID),
    instanceId: SYNTH_INSTANCE_ID,
    channelId: DEMO_TRACK_ID,
  });
  const filter = await host.mount({
    definition: registry.require(FILTER_DEFINITION_ID),
    instanceId: FILTER_INSTANCE_ID,
    channelId: DEMO_TRACK_ID,
  });

  // The harness owns every port node; only the harness's caller wires them
  // to each other and to the outside world (SS7).
  synth.output.connect(filter.input);
  filter.output.connect(destination);

  // SS18-M0 asks for the clip to be AUDIBLE; it should not also be clipped.
  // The phrase's 250 ms release overlaps every eighth-note boundary, so two
  // voices sum for part of each note, and a 0 dB instrument straight into the
  // destination peaks well past full scale (the destination then hard-clips on
  // real hardware). One device param, written through the same sanctioned path
  // the UI uses (`setLive` + one `commit`, SS3 fast path A), buys the headroom.
  const synthGain = synth.params.get("gain");
  if (synthGain !== undefined) {
    synthGain.setLive(DEMO_SYNTH_GAIN_DB, "user");
    synthGain.commit();
  }

  const noteTarget = instrumentToNoteTarget(synth.instance);
  const events = createClipEventSource([DEMO_CLIP]);

  const transport = createEngineTransport({
    context: ctx,
    tempoMap: DEMO_TEMPO_MAP,
    events,
    resolveTarget: (trackId) => (trackId === DEMO_TRACK_ID ? noteTarget : undefined),
    lookAheadSeconds: options.lookAheadSeconds,
    tickIntervalMs: options.tickIntervalMs,
    clock: options.clock,
  });

  return {
    transport,
    params,
    onParamCommit: (cb) => params.onCommit(cb),
    dispose(): void {
      transport.dispose();
      host.dispose();
      params.dispose();
    },
  };
}
