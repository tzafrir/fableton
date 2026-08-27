// A deterministic document to run commands against. Sequential ids mean every
// assertion can name the thing it is about (`clip-1`, `chan-2`) and two runs
// produce byte-identical documents.

import type { ChannelId, ClipId, DeviceInstanceId, IdFactory, NoteInit, Project, ProjectCommands } from "../../types";
import { PPQ } from "../../types";
import { createSequentialIdFactory } from "../ids";
import { createProjectCommands } from "../commands";
import { createEmptyProject, findMasterChannelId } from "../project";
import { createDocumentStore, type AppDocumentStore } from "../store";

export const QUARTER = PPQ;
export const EIGHTH = PPQ / 2;
export const SIXTEENTH = PPQ / 4;
export const BAR = PPQ * 4;

export interface Fixture {
  ids: IdFactory;
  commands: ProjectCommands;
  project: Project;
  store: AppDocumentStore;
  masterId: ChannelId;
  trackId: ChannelId;
  deviceId: DeviceInstanceId;
  clipId: ClipId;
}

/** `[start, pitch]` pairs -> `NoteInit`s an eighth long at velocity 100. */
export function notes(pairs: readonly (readonly [number, number])[]): NoteInit[] {
  return pairs.map(([start, pitch]) => ({ start, dur: EIGHTH, pitch, vel: 100 }));
}

export function makeFixture(): Fixture {
  const ids = createSequentialIdFactory();
  const commands = createProjectCommands(ids);
  const project = createEmptyProject({ ids, name: "Fixture" });
  const masterId = findMasterChannelId(project) ?? "";
  const trackId = project.channelOrder.find((id) => id !== masterId) ?? "";
  const clipId = Object.keys(project.clips)[0] ?? "";
  const deviceId = Object.keys(project.devices)[0] ?? "";
  const store = createDocumentStore(project, { now: () => 0 });
  return { ids, commands, project, store, masterId, trackId, deviceId, clipId };
}

/** A fixture whose clip already holds a C-major arpeggio (SS10 test data). */
export function makeFixtureWithNotes(): Fixture {
  const fixture = makeFixture();
  fixture.store.dispatch(
    fixture.commands.addNotes(
      fixture.clipId,
      notes([
        [0, 60],
        [0, 64],
        [EIGHTH, 67],
        [QUARTER, 72],
      ]),
    ),
  );
  fixture.store.clearHistory();
  return fixture;
}
