// SS13/SS18-M1 — the app shell's persistence wiring: storage backend
// selection, load-on-startup, autosave, and the explicit export/import
// menu's plumbing. Everything load-bearing already lives in `../persist/`;
// this module is just the seam that picks concrete implementations and hands
// the app shell one bootstrap call.

import {
  createAutosave,
  createOpfsProjectStorage,
  loadOrCreateProject,
  projectCodec,
  type LoadOrCreateResult,
} from "../persist";
import { type AppDocumentStore, createDocumentStore } from "../state";
import { createDemoProject } from "../demo";
import type { Autosave, CreateEmptyProject, ProjectStorage } from "../types";

/** The real backend the app ships with. OPFS reports `available: false` in a
 *  browser without it (SS13: "the app must still run, just without
 *  autosave") — never swapped for the in-memory double outside a test. */
export function createAppProjectStorage(): ProjectStorage {
  return createOpfsProjectStorage();
}

export interface BootstrapOptions {
  /**
   * The document a session starts from when there is nothing to resume
   * (SS13's `loadOrCreateProject` fallback). Defaults to the starter project
   * — M0's phrase expressed as a real document (`src/demo/project.ts`) — so
   * a first run opens something audible and Boot -> Play exercises the
   * SS3 document -> scheduler path rather than an empty clip. Tests that
   * want a blank document pass `createEmptyProject`.
   */
  readonly createProject?: CreateEmptyProject | undefined;
}

export interface BootstrapResult {
  readonly store: AppDocumentStore;
  readonly autosave: Autosave;
  readonly storage: ProjectStorage;
  readonly loadResult: LoadOrCreateResult;
}

/**
 * The whole-app startup sequence (SS13): resume the newest autosave, or
 * start from `options.createProject` (the starter project by default);
 * build the document store on top of whichever project came back; wire
 * autosave to it.
 */
export async function bootstrapProject(
  storage: ProjectStorage = createAppProjectStorage(),
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const loadResult = await loadOrCreateProject(storage, projectCodec, {
    createEmptyProject: options.createProject ?? createDemoProject,
  });
  const store = createDocumentStore(loadResult.project);
  const autosave = createAutosave({ store, storage, codec: projectCodec });
  return { store, autosave, storage, loadResult };
}
