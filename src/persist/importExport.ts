// SS13 — "explicit export/import of `.json` project files."
//
// Autosave (./autosave.ts) is the implicit path; this is the explicit one a
// menu item drives. Kept deliberately thin: `ProjectCodec` already owns
// serialization, so this module is just the browser-file plumbing around it
// — a `Blob`/download for export, a `Blob`/`File` -> `DecodeResult` for
// import — so it stays trivial to unit test (`importProjectText` needs no
// DOM at all) while still covering the one part that does (`downloadProjectFile`).

import type { DecodeResult, EncodeOptions, Project, ProjectCodec } from "../types";

const FILE_EXTENSION = ".json";

/** A safe-ish file name derived from the project name, e.g. `"My Song.json"`
 *  -> falls back to `"untitled.json"` for an empty/blank name. */
export function projectFileName(project: Project): string {
  const trimmed = project.name.trim();
  const base = trimmed.length > 0 ? trimmed : "untitled";
  const safe = base.replace(/[\\/:*?"<>|]+/g, "-");
  return `${safe}${FILE_EXTENSION}`;
}

/** Encodes `project` (pretty-printed by default, per `EncodeOptions`) into a
 *  downloadable `Blob`. No DOM dependency — safe to unit test directly. */
export function exportProjectBlob(codec: ProjectCodec, project: Project, options?: EncodeOptions): Blob {
  const text = codec.encode(project, options);
  return new Blob([text], { type: "application/json" });
}

export interface DownloadProjectFileOptions extends EncodeOptions {
  readonly fileName?: string | undefined;
}

/**
 * Triggers a real browser download via a transient object URL. Requires a
 * DOM (`document`, `URL.createObjectURL`); throws outside one rather than
 * silently doing nothing, so a headless caller finds out immediately.
 */
export function downloadProjectFile(
  codec: ProjectCodec,
  project: Project,
  options?: DownloadProjectFileOptions,
): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || !("createObjectURL" in URL)) {
    throw new Error("downloadProjectFile requires a browser DOM.");
  }
  const blob = exportProjectBlob(codec, project, options);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = options?.fileName ?? projectFileName(project);
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodes already-read project text (e.g. from a `FileReader`, or straight
 *  from disk in a test) — the headless half of the import path. */
export function importProjectText(codec: ProjectCodec, text: string): DecodeResult {
  return codec.decode(text);
}

/**
 * Reads a `Blob`/`File` as text. Prefers the standard `Blob.text()`; falls
 * back to `FileReader` for a DOM implementation that has one but not the
 * other (notably jsdom's `Blob`, which is what this package's own tests run
 * against under Vitest).
 */
export async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  if (typeof FileReader !== "undefined") {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read the file."));
      reader.readAsText(blob);
    });
  }
  throw new Error("This environment cannot read Blob contents (no Blob.text and no FileReader).");
}

/** Reads a `File`/`Blob` (an `<input type="file">` selection, or a
 *  drag-and-drop drop) and decodes it. */
export async function importProjectFile(codec: ProjectCodec, file: Blob): Promise<DecodeResult> {
  const text = await readBlobText(file);
  return importProjectText(codec, text);
}
