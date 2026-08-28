// SS7 — Device system (+ the SS5 panel declaration and the harness surface
// device authors code against).
//
// A device (instrument or effect) is a DEFINITION — pure data plus a
// factory — registered by id. Instances live behind stable audio ports and
// expose params through the registry. Nothing else in the app knows what a
// device does internally.
//
// `device-harness` (src/devices/harness/) implements the registry + host;
// `device-defs` (src/devices/core/, src/worklets/) writes definitions.

import type { Seconds, Unsub } from "./common";
import type {
  ChannelId,
  DeviceDefinitionId,
  DeviceInstanceId,
  ParamId,
} from "./ids";
import type { ParamDescriptor, ParamHandle, ParamRegistry } from "./params";

export type DeviceKind = "instrument" | "audioEffect";

/**
 * One audio port on a device. `id` is device-local (`'in'`, `'out'`, `'sc'`).
 * Declaring `{ id: 'sc', optional: true }` in `audioIn` is what makes a
 * device a sidechain target in the routing UI (SS6/SS14).
 */
export interface PortSpec {
  id: string;
  label?: string | undefined;
  optional?: boolean | undefined;
  /** Channel count the port expects; defaults to 2 (stereo). */
  channels?: number | undefined;
}

/**
 * The wiring endpoints the harness hands to `create`. `in`/`out` are the
 * primary `'in'` / `'out'` ports and are always present; `inputs`/`outputs`
 * address every declared port by id (`io.inputs['sc']`).
 *
 * Both sides are plain `AudioNode`s owned by the harness: a device connects
 * INTO `io.out` and reads FROM `io.in`, and never touches anything outside
 * the nodes it created plus these endpoints. The harness — not the device —
 * connects them to the surrounding chain, so a device can be created
 * before it is wired anywhere.
 */
/**
 * SS8 tempo, as much of it as a DEVICE may see.
 *
 * A tempo-synced delay or LFO needs one number — how long a beat is — and
 * needs to be told when it changes. It must NOT see the tempo map, the
 * transport or the document: a device that could read the song position
 * could also drift from the scheduler, and SS8 keeps tick<->seconds
 * conversion in exactly two places. This is a third seam only in the sense
 * that it converts a NOTE LENGTH, never a position.
 *
 * The harness supplies it; a device that ignores it is unaffected.
 */
export interface DeviceTempo {
  /** Seconds per quarter note at the current tempo. */
  secondsPerBeat(): Seconds;
  /** Fires after `secondsPerBeat()` changes. Returns an unsubscribe. */
  onChange(cb: () => void): Unsub;
}

/** Everything the harness hands a device besides its ports. */
export interface DeviceServices {
  tempo: DeviceTempo;
}

export interface DeviceIO {
  readonly in: AudioNode;
  readonly out: AudioNode;
  readonly inputs: Readonly<Record<string, AudioNode>>;
  readonly outputs: Readonly<Record<string, AudioNode>>;
}

/**
 * A live numeric READOUT a device publishes for its panel — the compressor's
 * gain reduction, and anything after it that is a number the user must SEE
 * but can never SET.
 *
 * Deliberately not a param: a param is a value the user owns, that automates,
 * undoes and is saved (SS4/SS13). A readout is the device telling the user
 * what it is doing right now. It is ephemeral by construction — it never
 * enters the document, has no handle, and is polled at rAF like the SS6
 * meters, which is the same "UI-only, never undoable, never saved" bucket.
 */
export interface DeviceReadoutSpec {
  /** DEVICE-LOCAL id, e.g. `"reduction"`. Public API, like a param id. */
  id: string;
  label: string;
  /** Real units (SS4: never normalized), e.g. `"dB"`. */
  unit?: string | undefined;
  /** Display range. `min` is the RESTING end — 0 dB of reduction, say. */
  min: number;
  max: number;
}

/** One named MIDI note of an instrument that is not played chromatically. */
export interface DeviceNoteName {
  /** MIDI note number, 0-127. */
  note: number;
  /** What it is — `"Kick"`, `"Open Hat"`. Shown in the piano roll's strip. */
  label: string;
}

/** SS5: device panels declare rows of `{ paramId, control? }`. */
export type ControlKind =
  | "knob"
  | "fader"
  | "steppedKnob"
  | "enumSelect"
  | "toggle";

export interface PanelControlSpec {
  /** DEVICE-LOCAL param id, matching a `DeviceDefinition.params[].id`. */
  paramId: string;
  /** Omit to let the control kit choose from `ParamDescriptor.kind`. */
  control?: ControlKind | undefined;
}

export interface PanelRowSpec {
  label?: string | undefined;
  controls: PanelControlSpec[];
}

/** Omit `panel` on a definition entirely to get the SS5 default panel. */
export interface PanelSpec {
  rows: PanelRowSpec[];
}

/**
 * SS7, verbatim in shape.
 *
 * `params[].id` values are DEVICE-LOCAL (`'cutoff'`) and are treated as
 * public API — renaming one requires a `migrateParams`. The harness derives
 * the global `ParamId` as `chan:<channelId>/dev:<instanceId>/<localId>`.
 */
export interface DeviceDefinition {
  /** Reverse-dotted, e.g. `"core.poly-synth"`, `"core.filter"`. */
  id: DeviceDefinitionId;
  version: number;
  kind: DeviceKind;
  label: string;
  params: ParamDescriptor[];
  audioIn: PortSpec[];
  audioOut: PortSpec[];
  /**
   * Synchronous, allocation-light node construction. The context may be an
   * `OfflineAudioContext` (SS12 export) — never assume `AudioContext`.
   */
  create(ctx: BaseAudioContext, io: DeviceIO, services: DeviceServices): DeviceInstance;
  /** Declarative panel rows; omit -> auto-generated from `params` (SS5). */
  panel?: PanelSpec | undefined;
  /** Live readouts this device publishes; the panel renders one meter each.
   *  A definition that declares these must implement `readValue`. */
  readouts?: readonly DeviceReadoutSpec[] | undefined;
  /**
   * For an instrument whose notes are not PITCHES: what each MIDI note is.
   *
   * A drum machine's C1 is not a low C, it is the kick — and a piano roll
   * that labels it "C1" is asking the user to memorise a mapping the device
   * already knows. An instrument that declares this gets its own names down
   * the roll's key strip, and the rows it does not name are drawn as the
   * dead space they are. Anything that plays chromatically simply omits it.
   */
  noteNames?: readonly DeviceNoteName[] | undefined;
  /**
   * One-time async setup per context, awaited by the harness before the
   * first `create` on that context — this is where a worklet-backed device
   * calls `ctx.audioWorklet.addModule(...)`. Must be idempotent.
   */
  prepare?: ((ctx: BaseAudioContext) => Promise<void>) | undefined;
  /** SS7 versioning: map values saved by an older `version` onto this one. */
  migrateParams?:
    | ((old: Readonly<Record<string, number>>, fromVersion: number) => Record<string, number>)
    | undefined;
}

/**
 * SS7, verbatim in shape. Created by `DeviceDefinition.create`.
 *
 * `when` arguments are audio-clock seconds (`ctx.currentTime` frame) and may
 * be in the future — instruments must schedule, never fire immediately.
 */
export interface DeviceInstance {
  /** Binds one device-local param to its registry handle (SS7 lifecycle). */
  connectParam(localId: string, handle: ParamHandle): void;
  /** Instruments only. `pitch` 0-127, `vel` 1-127. */
  noteOn?(pitch: number, vel: number, when: Seconds): void;
  noteOff?(pitch: number, when: Seconds): void;
  allNotesOff?(when: Seconds): void;
  /**
   * SS6 routing -> the device. A device cannot observe its own incoming
   * connections (Web Audio exposes no such API) and the harness owns its
   * ports, so a port that only sometimes carries signal — the compressor's
   * optional `sc` key above all — cannot tell "nothing routed here" from
   * "routed, currently silent". The reconciler calls this whenever an SS6
   * edge into a NON-DEFAULT input port appears or disappears, and once per
   * mount for the ports already wired. Ports named here are the optional
   * ones (`DeviceIO.inputs` keys other than `'in'`).
   */
  portRouted?(portId: string, routed: boolean): void;
  /**
   * Current value of one `DeviceDefinition.readouts` entry, in its own real
   * units. Called from the UI at rAF, so it must be a cheap field read — the
   * DSP side pushes into that field on its own schedule, never the reverse.
   * Returns `undefined` for an id this device does not publish.
   */
  readValue?(readoutId: string): number | undefined;
  /** Future PDC (SS6); return 0 when the device adds no latency. */
  latencySamples?(): number;
  /** Called after ramps/tails complete; must disconnect everything it made. */
  dispose(when?: Seconds): void;
}

/**
 * What `create` typically returns via the harness's `deviceInstance(...)`
 * helper (SS14). Keys map device-local param ids onto their fast path:
 * `audioParams` -> `ParamHandle.bindAudioParam`, `messageParams` ->
 * `ParamHandle.bindMessage`. Params listed in neither are still registered
 * and automatable; they simply have no live target.
 *
 * The harness may add further optional keys over time; devices must not
 * depend on the absence of any.
 */
export interface DeviceInstanceSpec {
  audioParams?: Readonly<Record<string, AudioParam>> | undefined;
  messageParams?:
    | Readonly<Record<string, (v: number, when: Seconds) => void>>
    | undefined;
  noteOn?: ((pitch: number, vel: number, when: Seconds) => void) | undefined;
  noteOff?: ((pitch: number, when: Seconds) => void) | undefined;
  allNotesOff?: ((when: Seconds) => void) | undefined;
  /** See `DeviceInstance.portRouted`. */
  portRouted?: ((portId: string, routed: boolean) => void) | undefined;
  /** See `DeviceInstance.readValue`. */
  readValue?: ((readoutId: string) => number | undefined) | undefined;
  latencySamples?: (() => number) | undefined;
  dispose(when?: Seconds): void;
}

/** Signature of the harness's `deviceInstance` helper (SS14). */
export type CreateDeviceInstance = (spec: DeviceInstanceSpec) => DeviceInstance;

/** SS7/SS14: `registry.register(StereoDelay)` — definitions keyed by id. */
export interface DeviceRegistry {
  register(def: DeviceDefinition): void;
  get(id: DeviceDefinitionId): DeviceDefinition | undefined;
  /** Like `get`, but throws when the id is unknown. */
  require(id: DeviceDefinitionId): DeviceDefinition;
  has(id: DeviceDefinitionId): boolean;
  list(): readonly DeviceDefinition[];
  /** Definitions of one kind — the browser panel's two lists. */
  listByKind(kind: DeviceKind): readonly DeviceDefinition[];
}

/** Where a mounted device sits, which is what its `ParamId`s are built from. */
export interface MountDeviceOptions {
  definition: DeviceDefinition;
  instanceId: DeviceInstanceId;
  channelId: ChannelId;
}

/**
 * A live device plus everything the caller needs to wire and control it.
 * Returned by `DeviceHost.mount`; M0's demo chain is two of these connected
 * end to end.
 */
export interface MountedDevice {
  readonly id: DeviceInstanceId;
  readonly channelId: ChannelId;
  readonly definition: DeviceDefinition;
  readonly instance: DeviceInstance;
  readonly io: DeviceIO;
  /** Convenience aliases for `io.in` / `io.out`. */
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Device-local param id -> registered handle. */
  readonly params: ReadonlyMap<string, ParamHandle>;
  /** Full `ParamId` for a device-local id, or `undefined` if not declared. */
  paramId(localId: string): ParamId | undefined;
  /** Unregisters params, then disposes the instance after `when`. */
  dispose(when?: Seconds): void;
}

/**
 * The SS7 lifecycle, executed in one place: `prepare` (once per context) ->
 * `create` -> register each descriptor as `chan:.../dev:.../<localId>` ->
 * `connectParam` for each -> instance is live.
 */
export interface DeviceHost {
  readonly context: BaseAudioContext;
  readonly registry: DeviceRegistry;
  mount(options: MountDeviceOptions): Promise<MountedDevice>;
  get(instanceId: DeviceInstanceId): MountedDevice | undefined;
  dispose(): void;
}

/** Signature of the harness's exported host factory. */
export type CreateDeviceHost = (
  ctx: BaseAudioContext,
  params: ParamRegistry,
  registry: DeviceRegistry,
) => DeviceHost;
