// What every arrangement verb needs, in one object.
//
// Handlers are constructed with this and nothing else: no closures over the
// view, no back-references into the DOM. That is what lets the FSM tests
// build a context out of a store, a scene and a selection model and drive the
// real handlers through the real gesture engine, headless (SS15).

import type { DocumentStore, ProjectCommands } from "../../types/commands";
import type { SelectionModel } from "../../types/editor";
import type { ChannelId, ClipId } from "../../types/ids";
import type { Ticks } from "../../types/time";
import type { ArrangementScene } from "./scene";

export interface ArrangementContext {
  readonly store: DocumentStore;
  readonly commands: ProjectCommands;
  /** Ephemeral (SS13): never in the document, never undoable, never saved. */
  readonly selection: SelectionModel<ClipId>;
  readonly scene: ArrangementScene;
  /** Where the transport is, for split-at-playhead and paste-like verbs. */
  playheadTicks(): Ticks;
  /** SS18-M1: "double-click clip opens the piano roll on it". */
  openClip(clipId: ClipId): void;
  selectChannel(channelId: ChannelId): void;
  /**
   * Arms "select whatever the next command creates". Ids are minted inside
   * the command factories (SS13), so a create/duplicate verb cannot know its
   * new clip ids up front — it reads them back off the patch stream instead
   * (types/commands: "read created ids from `CommandResult.patches`").
   */
  selectCreatedClips(): void;
}
