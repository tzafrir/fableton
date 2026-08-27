// `persistence` (SS13, load-bearing) — the JSON codec, migration runner,
// storage backends, autosave and explicit export/import that sit behind
// ../types/persist.ts.
//
// What is NOT here, on purpose: `CreateEmptyProject`/`IdFactory` (owned by
// `command-undo`, src/state/) and any canvas/editor concern. This package
// only ever touches `Project`/`ProjectFile` as data — it never mutates a
// live document, only encodes/decodes/validates one.

export { PROJECT_MIGRATIONS, runMigrations } from "./migrations";
export type { MigrationRunResult } from "./migrations";

export { createProjectCodec, projectCodec } from "./codec";

export { createMemoryProjectStorage, createOpfsProjectStorage } from "./storage";
export type { OpfsProjectStorageOptions } from "./storage";

export { createAutosave, toProject } from "./autosave";
export type { AutosaveDeps } from "./autosave";

export { loadOrCreateProject } from "./loadOrCreate";
export type { LoadOrCreateOptions, LoadOrCreateResult, ProjectSource } from "./loadOrCreate";

export {
  downloadProjectFile,
  exportProjectBlob,
  importProjectFile,
  importProjectText,
  projectFileName,
  readBlobText,
} from "./importExport";
export type { DownloadProjectFileOptions } from "./importExport";
