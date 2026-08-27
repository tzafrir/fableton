// SS6 + SS10 + SS13 — the v1 PROJECT DOCUMENT.
//
// "The document is plain serializable data behind a small store" (SS13). That
// is the whole contract of this file: every type below must survive
// `JSON.parse(JSON.stringify(x))` unchanged. No functions, no class
// instances, no `Map`/`Set`, no `undefined`-valued keys that matter, no
// audio-clock seconds (SS8: seconds never appear in the document), no
// normalized values (SS4: real units only), no ephemeral state (SS13:
// selection, viewport, meters and the free/automated/overridden param state
// live OUTSIDE the document and are never undoable and never saved).
//
// Written by the interface author; implemented as data by every M1 package.
// The store, the commands and the history that mutate it are in ./commands;
// the file envelope and migrations are in ./persist.

import type { MidiClip } from "./clip";
import type {
  ChannelId,
  ClipId,
  DeviceDefinitionId,
  DeviceInstanceId,
  LaneId,
  ParamId,
  RackChainId,
  RackId,
  RackMacroId,
} from "./ids";
import type { TempoSegment, Ticks, TimeSignature } from "./time";
import type { LoopRegion } from "./transport";

/** Stable id of a project (a fresh uuid-ish string per `createEmptyProject`). */
export type ProjectId = string;

/** SS6: tracks, groups, returns and the master are the SAME type + a role. */
export type ChannelRole = "track" | "group" | "return" | "master";

/**
 * SS6: "track only: instrument (later: audio clip player)". The source slot is
 * deliberately a tagged union so an `audioClip` source can be added in a later
 * schema version without changing `Channel`.
 */
export interface SourceRef {
  kind: "instrument";
  /** Key into `Project.devices`. */
  deviceId: DeviceInstanceId;
}

/**
 * One instantiated device (instrument or effect). Param VALUES are NOT stored
 * here — they live in `Project.paramValues` keyed by full `ParamId`, which is
 * exactly the shape `ParamRegistry.load()` / `.snapshot()` speak (SS4). One
 * value, one place, one patch path.
 */
export interface DeviceState {
  id: DeviceInstanceId;
  /** The `DeviceDefinition.id` to instantiate, e.g. `"core.poly-synth"`. */
  definitionId: DeviceDefinitionId;
  /** `DeviceDefinition.version` this state was saved from (SS7 migrations). */
  version: number;
  /** Which channel hosts it — the `chan:` segment of its params' ids (SS4). */
  channelId: ChannelId;
  /** Device on/off (the SS5 toggle in the device header). */
  enabled: boolean;
}

/** SS6 send: a tap from one channel into another (normally a return). */
export interface SendSpec {
  to: ChannelId;
  /** Registered mixer param carrying the amount; value lives in `paramValues`. */
  amount: ParamId;
  tap: "pre" | "post";
}

/**
 * SS6, verbatim in shape plus two cosmetic document fields (`name`, `color`)
 * that the arrangement header edits.
 *
 * `volume` / `pan` / `sends[].amount` are `ParamId`s, not numbers: the value
 * of a mixer param is a registry value like any device param and is stored in
 * `Project.paramValues`. M1 creates these ids and stores their values; M2
 * builds the strip that drives them.
 */
export interface Channel {
  id: ChannelId;
  role: ChannelRole;
  name: string;
  /** CSS color for the arrangement lane header + its clips; `null` = default. */
  color: string | null;
  /** Track only: the instrument slot (SS6/SS7). */
  source: SourceRef | null;
  /** Ordered effect chain; ids key into `Project.devices`. */
  chain: DeviceInstanceId[];
  volume: ParamId;
  pan: ParamId;
  mute: boolean;
  solo: boolean;
  sends: SendSpec[];
  /** Parent group or the master; `null` on the master (-> ctx.destination). */
  output: ChannelId | null;
}

/**
 * One PARALLEL chain inside a rack (SS7 "racks"). Its `devices` are ordinary
 * `DeviceState`s in `Project.devices` — a rack changes how a device is WIRED,
 * never what a device is, so every existing device command, param path and
 * automation lane keeps working for a device that moves into a chain.
 *
 * `gain`/`pan` are `ParamId`s for the same reason `Channel.volume` is: their
 * values live in `Project.paramValues` and are registry params like any
 * other, so they automate and undo with no special case.
 */
export interface RackChain {
  id: RackChainId;
  name: string;
  /** Ordered; `[]` is a legal (silent-but-dry) chain. */
  devices: DeviceInstanceId[];
  mute: boolean;
  solo: boolean;
  /** `chan:<c>/dev:<rack>/chain:<id>/gain`, in dB. */
  gain: ParamId;
  /** `chan:<c>/dev:<rack>/chain:<id>/pan`, -1..1. */
  pan: ParamId;
}

/**
 * SS7 macro: one knob fanned out to N device params, each over its own
 * sub-range. The macro is itself a registry param, so it automates like
 * anything else; the FAN-OUT is engine behaviour (M4 of the rack plan), not
 * document data beyond the target list.
 */
/** A macro's range: MIDI-CC-like, so it reads the same as a mapped CC. */
export const MACRO_MIN = 0;
export const MACRO_MAX = 127;
/** A new macro sits at 0, so adding one never moves what it is about to be
 *  mapped to. */
export const DEFAULT_MACRO_VALUE = 0;

export interface RackMacro {
  id: RackMacroId;
  name: string;
  /** `chan:<c>/dev:<rack>/macro:<id>`, 0-127 like a MIDI CC. */
  param: ParamId;
  /** Where the knob's 0..1 sweep lands on each target, in the target's own
   *  real units. `min > max` is legal and inverts the target. */
  targets: { paramId: ParamId; min: number; max: number }[];
}

/**
 * An effect rack: parallel chains between one split and one sum, occupying a
 * single slot of `Channel.chain`.
 *
 * A rack's `id` sits in `Channel.chain` exactly where a `DeviceInstanceId`
 * would, and is resolved against `Project.racks` FIRST — the two collections
 * share one id namespace and must stay disjoint (invariant 9). That is what
 * lets a rack be moved, removed and addressed by every command that already
 * speaks chain slots, and what makes its params ordinary `dev:` paths.
 */
export interface RackState {
  id: RackId;
  /** Which channel hosts it — the `chan:` segment of its params (SS4). */
  channelId: ChannelId;
  name: string;
  /** Rack on/off. Disabled = split wired straight to sum: the chains stay
   *  mounted and keep their state, exactly like a disabled device (SS7). */
  enabled: boolean;
  /** Ordered top-to-bottom in the UI; `[]` passes audio through dry. */
  chains: RackChain[];
  macros: RackMacro[];
}

/** SS6: sidechain is an explicit edge in the document, never a device hack. */
export interface SidechainEdge {
  from: { channel: ChannelId; tap: "preFx" | "postFx" | "postFader" };
  to: { device: DeviceInstanceId; port: "sc" };
}

/** SS11, verbatim. `v` is in real units; `curve` bends the segment that
 *  STARTS at this point. */
export interface AutoPoint {
  t: Ticks;
  v: number;
  /** -1..1 segment bend; 0 = straight line to the next point. */
  curve: number;
}

/**
 * SS11. Declared in the v1 schema even though M3 is what edits lanes: adding
 * a top-level collection later would be a migration, and SS7's swap semantics
 * ("lanes targeting the old instance's params are kept, greyed, and
 * re-bindable — never silently deleted") mean lanes must be able to outlive
 * the param they name. M1 ships `lanes: {}` and must round-trip whatever it
 * loads untouched.
 */
export interface AutomationLane {
  id: LaneId;
  /** The channel the lane renders under (SS11 "lanes hang off the channel"). */
  channelId: ChannelId;
  paramId: ParamId;
  /** Sorted by `t`, no two points on the same tick. */
  points: AutoPoint[];
  enabled: boolean;
}

/**
 * The v1 document root.
 *
 * INVARIANTS (commands must preserve every one; the persistence layer
 * validates them on load and rejects a file that breaks a structural one):
 *
 * 1. `tempo` is non-empty, sorted by `startTick`, and `tempo[0].startTick`
 *    is 0. v1 writes exactly one segment (SS8).
 * 2. `channelOrder` is a permutation of `Object.keys(channels)` — it is the
 *    top-to-bottom order of arrangement lanes, and the row index an editor
 *    Viewport maps to.
 * 3. Every `clip.trackId` names a channel that exists; every id used as a key
 *    equals the `id` field of the value stored under it.
 * 4. `clip.notes` is kept SORTED by `(start, pitch)` after every command. The
 *    kit's viewport culling binary-searches this array (SS9), and stable order
 *    is also what makes save output byte-stable (SS2).
 * 5. Note ticks are clip-relative (SS10/clip.ts), integer, `dur >= 1`,
 *    `pitch` 0-127, `vel` 1-127.
 * 6. `paramValues` values are REAL units (SS4) and are only meaningful for
 *    ids whose owning device/channel exists in this document.
 * 7. `devices[id].channelId` agrees with the channel whose `source` or
 *    `chain` names `id`.
 * 8. `racks` and `devices` never share a key, and every id in a
 *    `Channel.chain` resolves through exactly one of them. A rack's
 *    `channelId` agrees with the channel whose chain names it, and every
 *    `RackChain.devices` entry is a device on that same channel.
 * 9. No key holds `undefined`: absent optional data is `null` or an empty
 *    collection, so JSON round-trips are lossless.
 */
export interface Project {
  id: ProjectId;
  name: string;
  /** SS8 tempo map as data; the engine builds a `TempoMap` from it. */
  tempo: TempoSegment[];
  timeSignature: TimeSignature;
  /** Transport loop brace, in absolute song ticks. */
  loop: LoopRegion;
  /** Top-to-bottom lane order (see invariant 2). */
  channelOrder: ChannelId[];
  channels: Record<ChannelId, Channel>;
  devices: Record<DeviceInstanceId, DeviceState>;
  clips: Record<ClipId, MidiClip>;
  lanes: Record<LaneId, AutomationLane>;
  /** SS7 effect racks, keyed by the chain slot they occupy (see `RackState`).
   *  Additive: a document with no racks carries `{}`. */
  racks: Record<RackId, RackState>;
  sidechains: SidechainEdge[];
  /** `ParamId -> committed real-unit value` (SS4 `snapshot()` / `load()`). */
  paramValues: Record<ParamId, number>;
}
