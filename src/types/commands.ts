// SS13 — State, undo, persistence (the command/patch/history half).
//
//   interface Command { label: string; run(doc: Draft<Project>): void; }
//   dispatch(cmd) -> { patches, inverse } -> history.push -> subscribers get diffs
//
// Two rules the whole app depends on:
//
//   1. ONE user gesture = ONE command = ONE undo entry (SS3). A drag writes
//      nothing to the document while it moves — it previews (SS9) and commits
//      once on release. A continuous control writes through the param fast
//      path and commits once on release (SS4 `ParamHandle.commit`), which the
//      command bus turns into exactly one `setParamValue`.
//   2. Ephemeral state (selection, viewport, hover, meters, the
//      free/automated/overridden param state) NEVER enters the document and
//      never enters history (SS13).
//
// Implemented by `command-undo` in src/state/.

import type { Unsub } from "./common";
import type { MidiClip, Note } from "./clip";
import type {
  ChannelId,
  ClipId,
  DeviceDefinitionId,
  DeviceInstanceId,
  LaneId,
  NoteId,
  ParamId,
  RackChainId,
  RackId,
  RackMacroId,
} from "./ids";
import type { AutoPoint, Project, ProjectId, SidechainEdge } from "./document";
import type { Ticks, TimeSignature } from "./time";
import type { LoopRegion } from "./transport";

// --- read / write views of the document -------------------------------------

/**
 * Deeply readonly view. What every READER of the document gets: editors,
 * the engine glue, persistence. The store's state is structurally shared and
 * frozen — holding a snapshot across an edit is safe, and mutating one is a
 * bug the type system catches.
 */
export type Immutable<T> = T extends (infer E)[]
  ? readonly Immutable<E>[]
  : T extends ReadonlyArray<infer E>
    ? readonly Immutable<E>[]
    : T extends object
      ? { readonly [K in keyof T]: Immutable<T[K]> }
      : T;

/**
 * Deeply mutable view. What a `Command.run` gets — an immer draft in the
 * shipped implementation, a plain deep copy in a test double. Structurally
 * identical to the document interfaces themselves; the alias exists so
 * SS13's signature reads verbatim and so the read/write distinction is
 * visible at every call site.
 */
export type Draft<T> = T extends readonly (infer E)[]
  ? Draft<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Draft<T[K]> }
    : T;

/** The document as readers see it. */
export type ProjectSnapshot = Immutable<Project>;

// --- patches ----------------------------------------------------------------

export type PatchPathSegment = string | number;

/**
 * An immer-shaped JSON patch. Deliberately structurally compatible with
 * `immer`'s `Patch` so `produceWithPatches` output can be handed straight to
 * subscribers, and equally producible by hand.
 *
 * Paths are document-rooted: `["clips","clip-3","notes",7,"pitch"]`. This is
 * what lets a subscriber react to "effect moved from chain[2] to chain[0]"
 * with a targeted update instead of a full re-scan (SS13).
 */
export interface Patch {
  readonly op: "replace" | "add" | "remove";
  readonly path: readonly PatchPathSegment[];
  readonly value?: unknown;
}

// --- commands ---------------------------------------------------------------

/**
 * SS13, verbatim plus two optional hooks.
 *
 * `run` MUST be a pure function of `(doc, whatever the factory captured)`:
 * given the same document it must produce the same result every time, because
 * redo re-runs nothing — it re-applies the recorded patches — and because a
 * command may be constructed on one frame and dispatched on the next. In
 * particular, ids for created entities are generated EAGERLY by the factory
 * (before `run`), never inside it.
 */
export interface Command {
  /** Human label for the undo menu, e.g. `"Move Notes"`. Title Case. */
  label: string;
  run(doc: Draft<Project>): void;
  /**
   * Optional pre-flight check. Return a human-readable reason to reject the
   * edit (SS6's cycle check, splitting a looped clip); `null` to proceed.
   * The store calls this before `run` and dispatches nothing when it fails.
   */
  canRun?(doc: ProjectSnapshot): string | null;
  /**
   * Optional. When two consecutive dispatches carry the same non-empty
   * `coalesceKey`, the second replaces the first in history instead of
   * pushing a new entry (typing in a name field). NOT for drags — those
   * already produce exactly one command.
   */
  coalesceKey?: string | undefined;
}

/** One entry in the undo stack. */
export interface HistoryEntry {
  readonly id: number;
  readonly label: string;
  readonly patches: readonly Patch[];
  readonly inverse: readonly Patch[];
  /** `Date.now()` at dispatch. Diagnostics only — never persisted. */
  readonly at: number;
}

export type CommandResult =
  | {
      readonly status: "applied";
      readonly patches: readonly Patch[];
      readonly inverse: readonly Patch[];
      /** `null` when the dispatch asked not to be recorded. */
      readonly entry: HistoryEntry | null;
    }
  /** `run` produced no patches: nothing changed, nothing pushed. */
  | { readonly status: "noop" }
  /** `canRun` said no. The document is untouched. */
  | { readonly status: "rejected"; readonly reason: string };

export interface DispatchOptions {
  /** Apply without pushing an undo entry (default `true` = record it). */
  record?: boolean | undefined;
  /** Overrides `Command.coalesceKey` for this dispatch. */
  coalesceKey?: string | undefined;
}

/** Why the document changed — subscribers use it to skip their own echo. */
export type ChangeSource = "command" | "undo" | "redo" | "load" | "replace";

export interface DocumentChange {
  readonly source: ChangeSource;
  readonly label: string;
  readonly patches: readonly Patch[];
  readonly inverse: readonly Patch[];
  /** The document AFTER the change. */
  readonly doc: ProjectSnapshot;
}

/**
 * The small store SS13 puts the document behind. One instance per open
 * project; the app shell owns it and hands it to every editor.
 */
export interface DocumentStore {
  getState(): ProjectSnapshot;
  dispatch(command: Command, options?: DispatchOptions): CommandResult;
  /** N commands, ONE undo entry (a keyboard action spanning two clips). */
  batch(label: string, commands: readonly Command[], options?: DispatchOptions): CommandResult;

  undo(): HistoryEntry | null;
  redo(): HistoryEntry | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Label of the entry `undo()`/`redo()` would apply, for the menu. */
  undoLabel(): string | undefined;
  redoLabel(): string | undefined;
  clearHistory(): void;

  /** Fires once per applied change, after the new state is installed. */
  onChange(cb: (change: DocumentChange) => void): Unsub;

  /**
   * Installs a different document (project load / new project). Clears
   * history by default — undoing across a file load is not a thing.
   */
  replaceDocument(project: Project, options?: { label?: string | undefined; keepHistory?: boolean | undefined }): void;

  /** True when the document changed since the last `markSaved()` — this is
   *  what the autosave debounce (SS13) and the tab title watch. */
  isDirty(): boolean;
  markSaved(): void;
}

// --- id generation ----------------------------------------------------------

/**
 * Ids are generated by the factory functions, never inside `run` (see
 * `Command`). `command-undo` exports one implementation; passing explicit ids
 * into an `*Init` makes a command fully deterministic for tests.
 */
export interface IdFactory {
  project(): ProjectId;
  channel(): ChannelId;
  device(): DeviceInstanceId;
  clip(): ClipId;
  note(): NoteId;
  lane(): LaneId;
  /** A rack occupies a chain slot, so its id shares the device namespace —
   *  a distinct prefix keeps saved files readable, nothing more. */
  rack(): RackId;
  chain(): RackChainId;
  macro(): RackMacroId;
}

// --- command payload shapes -------------------------------------------------

/** A note as an editor proposes it; `id` is filled in by the factory. */
export interface NoteInit {
  id?: NoteId | undefined;
  start: Ticks;
  dur: Ticks;
  pitch: number;
  vel: number;
  muted?: boolean | undefined;
}

/** Relative move (SS10: "Moves are relative" — off-grid offsets survive). */
export interface NoteDelta {
  ticks: Ticks;
  /** Semitones. */
  pitch: number;
}

/** Absolute span for a resize; the drag handler already snapped the moving
 *  edge and left the anchored one alone (SS10). */
export interface NoteSpan {
  id: NoteId;
  start: Ticks;
  dur: Ticks;
}

export interface NoteVelocityEdit {
  id: NoteId;
  vel: number;
}

export interface ClipInit {
  id?: ClipId | undefined;
  trackId: ChannelId;
  start: Ticks;
  length: Ticks;
  notes?: readonly NoteInit[] | undefined;
  loop?: { start: Ticks; end: Ticks } | null | undefined;
  name?: string | undefined;
  color?: string | null | undefined;
}

export interface ClipDelta {
  ticks: Ticks;
  /** Rows moved in `channelOrder`; negative = up. */
  tracks: number;
}

/**
 * Absolute clip bounds after a trim. See `ProjectCommands.trimClips` for what
 * happens to note content when the LEFT edge moves.
 */
export interface ClipSpan {
  id: ClipId;
  start: Ticks;
  length: Ticks;
}

/**
 * Builds the document a brand-new project starts from: one master channel,
 * one track holding the default instrument (`core.poly-synth`), one empty
 * one-bar clip, 120 bpm, 4/4, loop disabled. Exported by `command-undo`;
 * `persistence` uses it as the fallback when nothing was autosaved.
 */
export type CreateEmptyProject = (options?: {
  name?: string | undefined;
  id?: ProjectId | undefined;
  ids?: IdFactory | undefined;
}) => Project;

/** Init for `addGroup` / `addReturn` — cosmetic fields only. */
export interface GroupInit {
  id?: ChannelId | undefined;
  name?: string | undefined;
  color?: string | null | undefined;
}

/** One device inside a rack preset's chain. */
export interface RackPresetDevice {
  definitionId: DeviceDefinitionId;
  version?: number | undefined;
  /** DEVICE-LOCAL param id -> value, applied as the instance is created. */
  params?: Readonly<Record<string, number>> | undefined;
  /** Adds an SS6 sidechain edge feeding this device's `sc` port from the
   *  HOSTING channel at the given tap. `preFx` is the only same-channel tap
   *  the routing rules allow, and the one gated reverb keys from. */
  sidechainFromHost?: "preFx" | "postFx" | "postFader" | undefined;
}

export interface RackPresetChain {
  name?: string | undefined;
  devices: readonly RackPresetDevice[];
}

/** A named parallel-chain patch (see `ProjectCommands.addRackPreset`). */
export interface RackPresetSpec {
  name: string;
  chains: readonly RackPresetChain[];
}

/** Init for a new device instance (`addEffect`, `setInstrument`). */
export interface DeviceInit {
  definitionId: DeviceDefinitionId;
  version?: number | undefined;
  deviceId?: DeviceInstanceId | undefined;
}

/** Init for `addLane` — explicit ids/points make tests deterministic. */
export interface LaneInit {
  id?: LaneId | undefined;
  points?: readonly AutoPoint[] | undefined;
}

export interface TrackInit {
  id?: ChannelId | undefined;
  name?: string | undefined;
  color?: string | null | undefined;
  /** Insert position in `channelOrder`; appended when omitted. */
  index?: number | undefined;
  /** Instrument for the source slot. `null`/omitted = empty track. */
  instrument?:
    | { definitionId: DeviceDefinitionId; version?: number | undefined; deviceId?: DeviceInstanceId | undefined }
    | null
    | undefined;
}

/**
 * The M1 edit vocabulary, frozen so editors can be written against it while
 * `command-undo` is still implementing it. `src/state/` exports one object
 * satisfying this interface (plus whatever M2+ adds).
 *
 * Every factory is pure and cheap: it captures its arguments (and eagerly
 * generated ids) and returns a `Command`. Ids of entities a command creates
 * can be read back from `CommandResult.patches`, or pinned by passing them in.
 */
export interface ProjectCommands {
  // notes (piano roll) — `clipId` scopes every one of them
  addNotes(clipId: ClipId, notes: readonly NoteInit[]): Command;
  deleteNotes(clipId: ClipId, noteIds: readonly NoteId[]): Command;
  /** Move by a delta; clamps pitch to 0-127 and start to >= 0 (SS10). */
  moveNotes(clipId: ClipId, noteIds: readonly NoteId[], delta: NoteDelta): Command;
  /** Resize to absolute spans; `dur` floors at `MIN_NOTE_TICKS` (SS10). */
  resizeNotes(clipId: ClipId, spans: readonly NoteSpan[]): Command;
  setNoteVelocities(clipId: ClipId, edits: readonly NoteVelocityEdit[]): Command;
  setNotesMuted(clipId: ClipId, noteIds: readonly NoteId[], muted: boolean): Command;
  /** Copy + move in one entry (SS10 `DragDup`, `Cmd/Ctrl+D`). */
  duplicateNotes(
    clipId: ClipId,
    noteIds: readonly NoteId[],
    delta: NoteDelta,
    newIds?: readonly NoteId[] | undefined,
  ): Command;
  /** SS10 `Cmd/Ctrl+U`: snap starts to `gridTicks`, durations unchanged. */
  quantizeNoteStarts(clipId: ClipId, noteIds: readonly NoteId[], gridTicks: Ticks): Command;

  // clips (arrangement)
  createClip(init: ClipInit): Command;
  deleteClips(clipIds: readonly ClipId[]): Command;
  moveClips(clipIds: readonly ClipId[], delta: ClipDelta): Command;
  /**
   * Trim/extend. Moving the RIGHT edge only changes `length`. Moving the LEFT
   * edge also shifts every note by the same delta (note ticks are
   * clip-relative, SS10) — notes that end up outside `[0, length)` are
   * dropped, and a note straddling the new left edge is clipped to it. That
   * `length` floors at `MIN_CLIP_TICKS`. The note loss is the accepted v1
   * simplification: the M0 clip event source has no
   * content-offset concept, and undo restores the notes exactly.
   */
  trimClips(spans: readonly ClipSpan[]): Command;
  /**
   * Split at an absolute song tick. Notes crossing the cut are cut in two.
   * REJECTED (via `canRun`) when the clip has a `loop`: unrolled content has
   * no single split point. The arrangement disables the verb in that case.
   */
  splitClip(clipId: ClipId, atTick: Ticks, newClipId?: ClipId | undefined): Command;
  duplicateClips(
    clipIds: readonly ClipId[],
    delta: ClipDelta,
    newIds?: readonly ClipId[] | undefined,
  ): Command;
  /** `null` clears the clip loop; bounds are clip-relative ticks (SS10). */
  setClipLoop(clipId: ClipId, loop: { start: Ticks; end: Ticks } | null): Command;
  renameClip(clipId: ClipId, name: string): Command;
  setClipColor(clipId: ClipId, color: string | null): Command;

  // channels / tracks
  addTrack(init?: TrackInit | undefined): Command;
  /** Also removes the tracks' clips, devices and `paramValues` entries. */
  deleteTracks(channelIds: readonly ChannelId[]): Command;
  renameChannel(channelId: ChannelId, name: string): Command;
  setChannelColor(channelId: ChannelId, color: string | null): Command;
  /** Reorders `channelOrder` (= arrangement row order). */
  moveChannel(channelId: ChannelId, toIndex: number): Command;
  setChannelMuted(channelId: ChannelId, muted: boolean): Command;
  setChannelSolo(channelId: ChannelId, solo: boolean): Command;

  // routing (SS6/SS18-M2) — every edge edit runs the DFS cycle check via
  // `canRun`, so a cycle-forming edit never reaches the store.
  /** New group channel; `memberIds` re-point their `output` into it. The
   *  group's own output is the members' common parent (or the master). */
  addGroup(memberIds?: readonly ChannelId[] | undefined, init?: GroupInit | undefined): Command;
  /** New return channel, output -> master. */
  addReturn(init?: GroupInit | undefined): Command;
  /**
   * Deletes channels of any non-master role. Group members re-point to the
   * group's own output; sends/sidechains into the deleted set are removed;
   * clips, devices and `paramValues` entries go with their channel.
   */
  deleteChannels(channelIds: readonly ChannelId[]): Command;
  /** Re-route a channel into a group / return target ("Audio To"). */
  setChannelOutput(channelId: ChannelId, output: ChannelId): Command;
  /** Adds (or re-taps) a send from `from` into `to`, seeding its amount
   *  param at silence. Rejected when it would loop. */
  setSend(from: ChannelId, to: ChannelId, tap?: "pre" | "post" | undefined): Command;
  removeSend(from: ChannelId, to: ChannelId): Command;
  /** SS6: sidechain is an explicit document edge ("Audio From" UI). One
   *  edge per (device, port): setting replaces any existing edge. */
  setSidechain(edge: SidechainEdge): Command;
  removeSidechain(deviceId: DeviceInstanceId, port?: string | undefined): Command;

  // devices (SS7) — chain edits; the reconciler turns each into a patch
  /** Insert an effect into a channel's chain (`index` omitted = append). */
  addEffect(channelId: ChannelId, init: DeviceInit, index?: number | undefined): Command;
  /** Remove devices from chains/source slots; their `paramValues` go too.
   *  Automation lanes naming their params are KEPT (SS7: never silently
   *  deleted — M3 renders them greyed + re-bindable). */
  removeDevices(deviceIds: readonly DeviceInstanceId[]): Command;
  /** Reorder within one channel's chain. */
  moveDevice(channelId: ChannelId, deviceId: DeviceInstanceId, toIndex: number): Command;
  setDeviceEnabled(deviceId: DeviceInstanceId, enabled: boolean): Command;
  /**
   * SS7 swap: replace a track's source instrument with a NEW instance of
   * `init.definitionId`. Clips are untouched; `carryValues` (device-LOCAL id
   * -> value) seeds compatible params — computed by the CALLER, which knows
   * both definitions; the document layer never imports the device library.
   */
  setInstrument(
    channelId: ChannelId,
    init: DeviceInit,
    carryValues?: Readonly<Record<string, number>> | undefined,
  ): Command;

  // racks (SS7) — a rack occupies one chain slot and holds PARALLEL chains
  /** New rack with one empty chain, at `index` of the channel's chain. */
  addRack(channelId: ChannelId, index?: number | undefined): Command;
  /** Wrap existing devices of one channel into a new rack's first chain,
   *  at the position of the earliest of them. The devices themselves are
   *  untouched — same instances, same params, same automation. */
  groupIntoRack(channelId: ChannelId, deviceIds: readonly DeviceInstanceId[]): Command;
  /** Dissolve a rack back into its channel's chain, chains concatenated in
   *  order. Per-chain gain/pan/mute are lost — they have nowhere to go. */
  ungroupRack(rackId: RackId): Command;
  addRackChain(rackId: RackId, name?: string | undefined): Command;
  /** Insert a NEW effect straight into a rack chain (`index` omitted =
   *  append). One command, so it is one undo entry — the two-step
   *  "add to the channel, then move it in" would be two. */
  addEffectToChain(
    rackId: RackId,
    chainId: RackChainId,
    init: DeviceInit,
    index?: number | undefined,
  ): Command;
  /** Removes the chain AND the devices in it (they have no other home). */
  removeRackChain(rackId: RackId, chainId: RackChainId): Command;
  /** Move a device into a chain of the same rack, or from the hosting
   *  channel's chain into one (`index` omitted = append). */
  moveDeviceToChain(
    rackId: RackId,
    deviceId: DeviceInstanceId,
    chainId: RackChainId,
    index?: number | undefined,
  ): Command;
  /**
   * Builds a whole rack — chains, devices, param values and sidechain edges —
   * in ONE command, so a factory patch is one undo entry and its ids are
   * minted eagerly like every other command's (never inside `run`).
   *
   * This is what a "rack preset" is: a device preset is a bag of values for
   * an instance that already exists (SS4), but a rack preset has to CREATE
   * the instances, which only a command can do.
   */
  addRackPreset(channelId: ChannelId, spec: RackPresetSpec, index?: number | undefined): Command;
  setChainMuted(rackId: RackId, chainId: RackChainId, muted: boolean): Command;
  setChainSolo(rackId: RackId, chainId: RackChainId, solo: boolean): Command;
  setRackEnabled(rackId: RackId, enabled: boolean): Command;
  renameRack(rackId: RackId, name: string): Command;
  renameRackChain(rackId: RackId, chainId: RackChainId, name: string): Command;

  // automation lanes (SS11/SS18-M3)
  /** One lane per (channel, param); adding an existing pair re-enables it. */
  addLane(channelId: ChannelId, paramId: ParamId, init?: LaneInit | undefined): Command;
  deleteLanes(laneIds: readonly LaneId[]): Command;
  /** Disabling keeps the data inert (SS11); the param returns to `free`. */
  setLaneEnabled(laneId: LaneId, enabled: boolean): Command;
  /** SS7: a lane that outlived its param re-binds to any other param. */
  rebindLane(laneId: LaneId, paramId: ParamId): Command;
  addLanePoint(laneId: LaneId, point: { t: Ticks; v: number; curve?: number | undefined }): Command;
  /** One drag = one command: points keyed by their tick at gesture start. */
  moveLanePoints(
    laneId: LaneId,
    edits: readonly { fromT: Ticks; toT: Ticks; v: number }[],
  ): Command;
  deleteLanePoints(laneId: LaneId, ticks: readonly Ticks[]): Command;
  /** Bends the segment STARTING at the point on `segmentStartT` (SS11). */
  setLaneSegmentCurve(laneId: LaneId, segmentStartT: Ticks, curve: number): Command;

  // params (the SS3 fast path's one document write, on gesture end)
  setParamValue(paramId: ParamId, value: number): Command;
  setParamValues(values: Readonly<Record<ParamId, number>>): Command;

  // song
  renameProject(name: string): Command;
  /** v1 single-segment tempo map (SS8). */
  setTempo(bpm: number): Command;
  setTimeSignature(signature: TimeSignature): Command;
  setLoopRegion(loop: LoopRegion): Command;

  /** Escape hatch for one-off edits that do not deserve a named factory. */
  custom(label: string, run: (doc: Draft<Project>) => void): Command;
}

/**
 * Reading helper the editors and the engine glue both want and neither should
 * re-implement: clips of one track, in start order. Exported by `src/state/`
 * alongside the commands.
 */
export type ClipsOfTrack = (
  doc: ProjectSnapshot,
  trackId: ChannelId,
) => readonly Immutable<MidiClip>[];

/** Same shape for notes, used by the piano roll's culling (SS9). */
export type NotesOfClip = (doc: ProjectSnapshot, clipId: ClipId) => readonly Immutable<Note>[];
