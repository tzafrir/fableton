// SS13 — "Project = versioned JSON (schemaVersion + ordered migrations, same
// discipline as device versions in SS7)."
//
// A migration is a pure `JsonValue -> JsonValue` step over the ENVELOPE's
// `project` member (never over the typed `Project` — see ./codec for where
// the migrated value is finally parsed into one). Steps run in order from
// the file's `schemaVersion` up to `PROJECT_SCHEMA_VERSION`.

import type { JsonValue, ProjectMigration } from "../types";
import { PROJECT_SCHEMA_VERSION } from "../types";

/**
 * Ordered migration steps. `PROJECT_SCHEMA_VERSION` is 1 — the first shipped
 * schema — so there is nothing a real build ever wrote that predates it. The
 * discipline still has to exist and be exercised before a second migration
 * is ever written under pressure, so this scaffold ships exactly ONE slot: a
 * `0 -> 1` identity step. It only fires for a hand-authored or synthetic file
 * whose `schemaVersion` is missing or `0` — never something Fableton itself
 * wrote — and its job is solely to prove the runner threads a version number
 * through correctly.
 *
 * When SS13/SS7's shape changes and `PROJECT_SCHEMA_VERSION` bumps to 2, add
 * the real `1 -> 2` step here, in order, in the SAME commit as the bump.
 * Never remove or renumber an existing step: old files must keep migrating.
 */
export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [
  {
    from: 0,
    to: 1,
    label: "Bootstrap: no schema existed before v1",
    migrate: (project: JsonValue): JsonValue => project,
  },
];

export interface MigrationRunResult {
  readonly value: JsonValue;
  /** The version the file was written at, when any migration ran. */
  readonly migratedFrom: number | undefined;
  /** Set instead of a result when no path from `fromVersion` exists. */
  readonly error: string | undefined;
}

/**
 * Walks `migrations` from `fromVersion` to `PROJECT_SCHEMA_VERSION`,
 * applying each step's `migrate` in order. A no-op when the file is already
 * current. Every step must be findable by its `from`; a gap in the chain (or
 * a file newer than this build understands) is reported via `.error` rather
 * than thrown, so callers can turn it into a `DecodeResult`.
 */
export function runMigrations(
  fromVersion: number,
  value: JsonValue,
  migrations: readonly ProjectMigration[] = PROJECT_MIGRATIONS,
  /** Exposed for tests that want to exercise a multi-step chain without
   *  waiting for `PROJECT_SCHEMA_VERSION` to actually reach that number in
   *  production; real callers always take the default. */
  targetVersion: number = PROJECT_SCHEMA_VERSION,
): MigrationRunResult {
  if (fromVersion === targetVersion) {
    return { value, migratedFrom: undefined, error: undefined };
  }
  if (fromVersion > targetVersion) {
    return {
      value,
      migratedFrom: undefined,
      error: `This project was saved by a newer version of Fableton (schema ${fromVersion}).`,
    };
  }

  const byFrom = new Map<number, ProjectMigration>();
  for (const step of migrations) byFrom.set(step.from, step);

  let current = value;
  let version = fromVersion;
  while (version < targetVersion) {
    const step = byFrom.get(version);
    if (!step) {
      return {
        value: current,
        migratedFrom: fromVersion,
        error: `No migration path from schema ${version} to ${targetVersion}.`,
      };
    }
    current = step.migrate(current);
    version = step.to;
  }
  return { value: current, migratedFrom: fromVersion, error: undefined };
}
