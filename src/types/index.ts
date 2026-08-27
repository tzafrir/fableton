// Shared type contract for the whole app (SS4, SS6-SS8, SS10, SS12).
//
// This directory is interfaces only — it must never gain runtime behaviour
// (the two numeric constants below are shared vocabulary, not logic). Every
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

export type {
  ControlKind,
  CreateDeviceHost,
  CreateDeviceInstance,
  DeviceDefinition,
  DeviceHost,
  DeviceIO,
  DeviceInstance,
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
