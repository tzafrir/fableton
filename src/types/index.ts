// Shared type contract for the whole app (SS4, SS6-SS8, SS10, SS12).
//
// This directory is interfaces only — it must never gain runtime behaviour
// (the handful of numeric constants below are shared vocabulary, not logic:
// PPQ, the look-ahead/tick periods, the schema version, and the pixel/tick
// thresholds SS9/SS10 fix by name). Every
// package imports its types from here, with `import type`, so no package
// ever depends on another package's module at type level:
//
//   import type { ParamHandle, TempoMap } from "../types";
//   import { PPQ } from "../types";
//
// Deep imports (`../types/params`) are equally fine; the barrel is the
// convenience path.

export type { Milliseconds, Normalized, Seconds, Unsub } from "./common";

export type {
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

export type {
  ParamDescriptor,
  ParamHandle,
  ParamKind,
  ParamRegistry,
  ParamState,
  ParamWriteSource,
  Taper,
  TaperMapping,
} from "./params";

export type {
  BarBeatTick,
  Bpm,
  TempoMap,
  TempoSegment,
  Ticks,
  TimeSignature,
} from "./time";
export { PPQ, TICKS_PER_WHOLE_NOTE } from "./time";

export type { MidiClip, Note } from "./clip";

// --- M1 (SS9, SS10, SS13) ---------------------------------------------------

export type {
  AutomationLane,
  AutoPoint,
  Channel,
  ChannelRole,
  DeviceState,
  Project,
  ProjectId,
  RackChain,
  RackMacro,
  RackState,
  SendSpec,
  SidechainEdge,
  SourceRef,
} from "./document";

export type {
  ChangeSource,
  ClipDelta,
  ClipInit,
  RackPresetChain,
  RackPresetDevice,
  RackPresetSpec,
  ClipSpan,
  ClipsOfTrack,
  CreateEmptyProject,
  Command,
  CommandResult,
  DispatchOptions,
  DocumentChange,
  DocumentStore,
  Draft,
  HistoryEntry,
  IdFactory,
  Immutable,
  NoteDelta,
  NoteInit,
  NoteSpan,
  NoteVelocityEdit,
  NotesOfClip,
  Patch,
  PatchPathSegment,
  ProjectCommands,
  ProjectSnapshot,
  DeviceInit,
  GroupInit,
  LaneInit,
  TrackInit,
} from "./commands";

export type {
  Autosave,
  AutosaveOptions,
  AutosaveState,
  AutosaveStatus,
  DecodeResult,
  EncodeOptions,
  JsonValue,
  LoadWarning,
  ProjectCodec,
  ProjectFile,
  ProjectMigration,
  ProjectStorage,
} from "./persist";
export { AUTOSAVE_DEBOUNCE_MS, PROJECT_SCHEMA_VERSION } from "./persist";

export type {
  CreateViewport,
  Grid,
  GridSettings,
  Row,
  RowRange,
  SnapMode,
  TickRange,
  Viewport,
  ViewportLimits,
  ViewportOptions,
} from "./viewport";

export type {
  CreateRenderer,
  CreateTickIndex,
  EditorLayer,
  LayerFrame,
  LayerKind,
  PlayheadView,
  Renderer,
  RendererOptions,
  TickIndex,
  TickSpan,
} from "./render";

export type {
  ClickInfo,
  CreateGestureEngine,
  DragHandler,
  DragUpdate,
  EditorPoint,
  GestureEngine,
  GestureEngineOptions,
  GesturePhase,
  GestureStart,
  HitTarget,
  HitTester,
  KeyBinding,
  KeyInput,
  KeyOutcome,
  Modifiers,
  PointerInput,
  WheelInput,
} from "./gesture";
export { DRAG_THRESHOLD_PX } from "./gesture";

export type { DocumentNoteEventSource, ProjectEngine } from "./engine";

export type {
  ArrangementOptions,
  ArrangementView,
  AuditionSink,
  CreateArrangement,
  CreateEditorHost,
  CreatePianoRoll,
  EditorDocReader,
  EditorHost,
  EditorHostOptions,
  EditorView,
  EditorViewOptionsBase,
  PianoRollOptions,
  PianoRollView,
  SelectionModel,
  ToolMode,
} from "./editor";
export {
  DEFAULT_NOTE_VELOCITY,
  EDGE_ZONE_FRACTION,
  EDGE_ZONE_PX,
  FINE_NUDGE_TICKS,
  MIN_CLIP_TICKS,
  MIN_NOTE_TICKS,
} from "./editor";

export type {
  ControlKind,
  CreateDeviceHost,
  CreateDeviceInstance,
  DeviceDefinition,
  DeviceHost,
  DeviceIO,
  DeviceInstance,
  DeviceServices,
  DeviceTempo,
  DeviceInstanceSpec,
  DeviceKind,
  DeviceRegistry,
  MountDeviceOptions,
  MountedDevice,
  PanelControlSpec,
  PanelRowSpec,
  PanelSpec,
  PortSpec,
} from "./devices";

export type {
  ClockCommand,
  ClockTickMessage,
  CreateClipEventSource,
  CreateTransport,
  LoopRegion,
  NoteEvent,
  NoteEventSource,
  NoteEventType,
  NoteTarget,
  NoteTargetResolver,
  Transport,
  TransportDeps,
  TransportState,
  WindowFiller,
} from "./transport";
export {
  DEFAULT_LOOKAHEAD_SECONDS,
  DEFAULT_TICK_INTERVAL_MS,
} from "./transport";
