// The M1 edit vocabulary (types/commands `ProjectCommands`), assembled.
//
// Every factory is pure and cheap: it captures its arguments and the ids it
// mints EAGERLY, then returns a `Command` whose `run` is a pure function of
// the document. Nothing here touches the store — dispatching is the caller's
// decision, which is what makes `batch` (N commands, one undo entry) and
// headless FSM tests possible.

import type { IdFactory, ProjectCommands } from "../../types";
import { defaultIdFactory } from "../ids";
import { createChannelCommands } from "./channels";
import { createClipCommands } from "./clips";
import { createLaneCommands } from "./lanes";
import { createNoteCommands } from "./notes";
import { createRoutingCommands } from "./routing";
import { createSongCommands } from "./song";

export function createProjectCommands(ids: IdFactory = defaultIdFactory): ProjectCommands {
  return {
    ...createNoteCommands(ids),
    ...createClipCommands(ids),
    ...createChannelCommands(ids),
    ...createRoutingCommands(ids),
    ...createLaneCommands(ids),
    ...createSongCommands(),
  };
}

/** The ready-made vocabulary the app shell and the editors import. */
export const projectCommands: ProjectCommands = createProjectCommands();

export { MIN_BPM, MAX_BPM } from "./song";
export { noteFromInit } from "./notes";
export type { ChannelCommands } from "./channels";
export { DEFAULT_SEND_DB } from "./routing";
export type { RoutingCommands } from "./routing";
export type { LaneCommands } from "./lanes";
export type { ClipCommands } from "./clips";
export type { NoteCommands } from "./notes";
export type { SongCommands } from "./song";
