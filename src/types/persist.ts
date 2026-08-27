// SS13 — Persistence. "Project = versioned JSON (`schemaVersion` + ordered
// migrations, same discipline as device versions in SS7). Autosave debounced
// ~2 s to OPFS; explicit export/import of `.json` project files."
//
// Implemented by `persistence` in src/persist/.

import type { Unsub } from "./common";
import type { Project } from "./document";

/** Anything `JSON.parse` can produce. Migrations run on this, not on
 *  `Project` — a v1 migration must not be re-typed when v2 lands. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The v1 document shape's version. BUMP THIS whenever `Project` changes in a
 * way an older file cannot satisfy, and add a `ProjectMigration` from the old
 * number to the new one in the same commit.
 */
export const PROJECT_SCHEMA_VERSION = 1;

/** SS13: "Autosave debounced ~2 s to OPFS". */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

/**
 * The on-disk / on-wire envelope. The envelope carries everything volatile
 * (when it was saved, which build wrote it); `project` carries nothing
 * volatile at all, which is what makes SS2's "open -> edit -> save -> reopen
 * byte-stable except for edits" testable.
 */
export interface ProjectFile {
  /** Format marker so a stray JSON file is rejected with a real message. */
  format: "fableton.project";
  schemaVersion: number;
  /** ISO-8601. Envelope-only: it changes every save and never affects
   *  `project`, so a byte-stability test compares the `project` member. */
  savedAt: string;
  /** Writing app build id, diagnostics only. */
  app?: { name: string; version: string } | undefined;
  project: Project;
}

/**
 * One ordered step. Migrations are pure `JsonValue -> JsonValue` on the
 * ENVELOPE's `project` member and must be total: given any document a build
 * that wrote `from` could produce, return one a build reading `to` accepts.
 */
export interface ProjectMigration {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  migrate(project: JsonValue): JsonValue;
}

/** A recoverable complaint: something was dropped, clamped or defaulted. */
export interface LoadWarning {
  /** Dotted document path, e.g. `"clips.clip-3.notes[7].pitch"`. */
  path: string;
  message: string;
}

export type DecodeResult =
  | {
      readonly ok: true;
      readonly project: Project;
      /** Present when migrations ran; the version the file was written at. */
      readonly migratedFrom?: number | undefined;
      readonly warnings: readonly LoadWarning[];
    }
  | {
      readonly ok: false;
      /** User-facing, one sentence: "Not a Fableton project file." */
      readonly error: string;
      /** Schema version of the file, when it could be read at all — used to
       *  say "saved by a newer version of Fableton". */
      readonly schemaVersion?: number | undefined;
    };

export interface EncodeOptions {
  /** Envelope `savedAt`; defaults to now. Pin it to make output byte-stable. */
  savedAt?: string | undefined;
  /** Pretty-print for `.json` export (default) vs. compact for autosave. */
  pretty?: boolean | undefined;
}

/**
 * The single JSON boundary. Both directions live here so the byte-stability
 * rule has one owner.
 *
 * `encode` MUST be deterministic: object keys are written in a FIXED order
 * (the declaration order in ./document, and for id-keyed records the order of
 * the matching order array — `channelOrder` — or lexicographic id order where
 * there is none), numbers are written as-is (ticks are integers, SS8), and
 * `undefined`-valued members are omitted rather than serialized as `null`.
 * Two encodes of the same document must produce identical strings.
 */
export interface ProjectCodec {
  encode(project: Project, options?: EncodeOptions): string;
  decode(text: string): DecodeResult;
  /** Decode from an already-parsed value (autosave keeps objects around). */
  decodeValue(value: JsonValue): DecodeResult;
  /** Validates + repairs the ./document invariants; used by both decoders and
   *  worth calling in tests after a command storm. */
  validate(project: Project): readonly LoadWarning[];
}

/**
 * Where autosave puts bytes. One slot per project id; the implementation is
 * OPFS (`navigator.storage.getDirectory()`), and the in-memory double is what
 * unit tests use. `available` is false where OPFS is missing — the app must
 * still run, just without autosave.
 */
export interface ProjectStorage {
  readonly kind: "opfs" | "memory";
  readonly available: boolean;
  /** Newest autosaved text, or `null` when nothing was ever written. */
  read(key: string): Promise<string | null>;
  write(key: string, text: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Keys currently held, newest-first where the backend can tell. */
  list(): Promise<readonly string[]>;
}

export type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface AutosaveStatus {
  readonly state: AutosaveState;
  /** Audio-clock-independent wall time of the last successful write. */
  readonly lastSavedAt: number | null;
  readonly error: string | null;
}

/**
 * Debounced writer. It subscribes to `DocumentStore.onChange` (SS13) — one
 * pending write regardless of how many commands land inside the window — and
 * calls `markSaved()` after a successful write.
 */
export interface Autosave {
  readonly status: AutosaveStatus;
  /**
   * Writes now if anything is pending; resolves when the write settles.
   * Called on `visibilitychange`/`pagehide`, before an explicit export, and
   * before New/Import replace the document.
   *
   * The payload is captured SYNCHRONOUSLY, before this returns: a caller may
   * call `flush()` and replace the document in the very next statement and
   * still be sure the OUTGOING project's bytes are the ones that land in its
   * slot. (Without that guarantee, New/Import silently destroy every edit
   * made inside the debounce window.)
   */
  flush(): Promise<void>;
  onStatusChange(cb: (status: AutosaveStatus) => void): Unsub;
  /** Stops the timer and unsubscribes; does NOT flush. */
  dispose(): void;
}

export interface AutosaveOptions {
  debounceMs?: number | undefined;
  /** Storage key; defaults to the project's id. */
  key?: string | undefined;
}
