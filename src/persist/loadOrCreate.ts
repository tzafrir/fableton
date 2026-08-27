// SS13 — the "nothing autosaved yet" bootstrap path.
//
// `commands.ts` documents `CreateEmptyProject` as: "Exported by
// `command-undo`; `persistence` uses it as the fallback when nothing was
// autosaved." This package must not import `command-undo`'s implementation
// (it is being written concurrently in the same wave — see the persistence
// work package's file-ownership note), so the dependency is inverted: the
// factory is passed in by the caller (the app-shell, which legitimately
// depends on both packages) rather than imported here. Only the FROZEN
// `CreateEmptyProject` type crosses this file's boundary.

import type { CreateEmptyProject, DecodeResult, LoadWarning, Project, ProjectCodec, ProjectStorage } from "../types";

export type ProjectSource = "storage" | "created";

export interface LoadOrCreateResult {
  readonly project: Project;
  readonly source: ProjectSource;
  readonly warnings: readonly LoadWarning[];
  /** Set when a stored file existed but failed to decode — `project` is a
   *  fresh one in that case, not the corrupt file's contents. */
  readonly loadError?: string | undefined;
}

export interface LoadOrCreateOptions {
  /** Storage key to look for. Omit to use the newest key `storage.list()`
   *  reports (a fresh session that doesn't know a project id yet). */
  readonly key?: string | undefined;
  readonly createEmptyProject: CreateEmptyProject;
  readonly newProjectName?: string | undefined;
}

/**
 * The whole-app startup call: try to resume the last autosave, and fall
 * back to `createEmptyProject()` when there is nothing to resume (no
 * storage, no key, or a file that fails to decode).
 */
export async function loadOrCreateProject(
  storage: ProjectStorage,
  codec: ProjectCodec,
  options: LoadOrCreateOptions,
): Promise<LoadOrCreateResult> {
  const key = options.key ?? (storage.available ? (await storage.list())[0] : undefined);

  if (storage.available && key !== undefined) {
    const text = await storage.read(key);
    if (text !== null) {
      const result: DecodeResult = codec.decode(text);
      if (result.ok) {
        return { project: result.project, source: "storage", warnings: result.warnings };
      }
      const created = options.createEmptyProject({ name: options.newProjectName });
      return { project: created, source: "created", warnings: [], loadError: result.error };
    }
  }

  const project = options.createEmptyProject({ name: options.newProjectName });
  return { project, source: "created", warnings: [] };
}
