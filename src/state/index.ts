// `command-undo` (SS13, load-bearing) — THE state seam.
//
// The project document is plain serializable data behind a small store; every
// structural edit is a `Command` whose `run` mutates an immer draft; dispatch
// produces `{patches, inverse}`; history push makes undo/redo mechanical; and
// subscribers receive the patch stream, so an editor or the reconciler reacts
// to "note 7's pitch changed" with a targeted update instead of a re-scan.
//
// What is NOT here, on purpose (SS13/SS15): selection, viewport, hover, tool
// mode, meters and the free/automated/overridden param state. Those are
// ephemeral, live in Zustand next to the components that own them, and are
// never undoable and never saved.

export { createDocumentStore, DEFAULT_HISTORY_LIMIT } from "./store";
export type { AppDocumentStore, DocumentStoreOptions, ReplaceDocumentOptions } from "./store";

export { createProjectCommands, projectCommands, MAX_BPM, MIN_BPM, noteFromInit } from "./commands";
export type {
  ChannelCommands,
  ClipCommands,
  NoteCommands,
  SongCommands,
} from "./commands";

export {
  barTicks,
  createEmptyProject,
  defaultMixerParamValues,
  findMasterChannelId,
  makeChannel,
  makeInstrumentDevice,
  DEFAULT_BPM,
  DEFAULT_INSTRUMENT_DEFINITION_ID,
  DEFAULT_INSTRUMENT_VERSION,
  DEFAULT_PAN,
  DEFAULT_PROJECT_NAME,
  DEFAULT_TIME_SIGNATURE,
  DEFAULT_VOLUME_DB,
  MASTER_CHANNEL_NAME,
  ONE_BAR_TICKS,
} from "./project";
export type { MakeChannelOptions } from "./project";

export { createIdFactory, createSequentialIdFactory, defaultIdFactory } from "./ids";
export type { IdFactoryOptions } from "./ids";

export {
  channelAtRow,
  channelsInOrder,
  clipsForEngine,
  clipsOfTrack,
  notesOfClip,
  rowOfChannel,
  tracksInOrder,
} from "./select";

export { applyParamValues, connectParamRegistry } from "./paramBridge";
export type { ParamBridgeOptions } from "./paramBridge";
