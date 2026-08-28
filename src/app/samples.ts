// Importing an audio file, and restoring the ones a project already has.
//
// This is the join the rest of the app is deliberately kept out of: the
// document holds a REFERENCE (`AssetId` + metadata), storage holds the bytes,
// and the engine's library holds the decoded buffer. Three places, one
// operation, so it lives in one function rather than in a click handler.
//
// Kept headless — it takes plain dependencies, not a React ref or a panel —
// so the ordering rules below are unit-testable (SS15).

import type { AppAssetLibrary } from "../engine/assets/library";
import type { AssetStore } from "../persist/assets";
import type { AssetId, DocumentStore, IdFactory, ProjectCommands, ProjectSnapshot } from "../types";

export interface SampleImportDeps {
  readonly store: DocumentStore;
  readonly commands: ProjectCommands;
  readonly assets: AppAssetLibrary;
  readonly assetStore: AssetStore;
  readonly ids: IdFactory;
}

/** What the user gets told. `assetId` is set only on success. */
export type SampleImportResult =
  | { readonly status: "imported"; readonly assetId: AssetId; readonly name: string }
  | { readonly status: "rejected"; readonly reason: string };

/** The subset of `File` this needs — so a test can hand it a plain object. */
export interface ImportableFile {
  readonly name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Refuses anything this big before reading it. Base64 in `ProjectStorage`
 *  costs 33% on top, and a browser storage quota is not large: past this a
 *  sample is a liability rather than an instrument. */
export const MAX_SAMPLE_BYTES = 24 * 1024 * 1024;

/**
 * Import one audio file: decode it, keep its bytes, and register it in the
 * document.
 *
 * The ORDER is the interesting part. Decoding happens FIRST, before anything
 * is written or dispatched, so a file the browser cannot read leaves no
 * orphan bytes in storage and no asset in the document pointing at silence.
 * Bytes are written SECOND, before the command, so an asset that exists in
 * the document is always one whose samples survive a reload. The command is
 * LAST, and is the only step that is undoable — which is the right shape:
 * undoing an import should forget the reference, not delete the file's bytes
 * out from under a redo.
 */
export async function importSample(
  file: ImportableFile,
  deps: SampleImportDeps,
): Promise<SampleImportResult> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { status: "rejected", reason: `Could not read ${file.name}.` };
  }
  if (bytes.byteLength === 0) {
    return { status: "rejected", reason: `${file.name} is empty.` };
  }
  if (bytes.byteLength > MAX_SAMPLE_BYTES) {
    const mb = Math.round(MAX_SAMPLE_BYTES / (1024 * 1024));
    return { status: "rejected", reason: `${file.name} is larger than ${String(mb)} MB.` };
  }

  const assetId = deps.ids.asset();
  const buffer = await deps.assets.load(assetId, bytes);
  if (buffer === null) {
    deps.assets.drop(assetId);
    return { status: "rejected", reason: `${file.name} is not audio this browser can decode.` };
  }

  try {
    await deps.assetStore.put(assetId, bytes);
  } catch {
    deps.assets.drop(assetId);
    return { status: "rejected", reason: `There was no room to store ${file.name}.` };
  }

  deps.store.dispatch(
    deps.commands.addAsset({
      id: assetId,
      name: file.name,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      frames: buffer.length,
    }),
  );
  return { status: "imported", assetId, name: file.name };
}

/**
 * Decodes every asset the document references and the library does not
 * already hold — the other half of persistence, run once after the engine
 * boots and again whenever the document gains an asset it has no buffer for
 * (an undo of a remove, or an imported project file).
 *
 * Failures are silent by design: a missing or corrupt slot means that
 * sampler plays nothing, which the user can see and fix, and there is no
 * useful action to offer at load time. `library.has` records the attempt, so
 * a file that will never decode is not re-read on every document change.
 */
export async function loadProjectSamples(
  doc: ProjectSnapshot,
  assets: AppAssetLibrary,
  assetStore: AssetStore,
): Promise<number> {
  let loaded = 0;
  for (const assetId of Object.keys(doc.assets)) {
    if (assets.has(assetId)) continue;
    let bytes: ArrayBuffer | null = null;
    try {
      bytes = await assetStore.get(assetId);
    } catch {
      bytes = null;
    }
    if (bytes === null) continue;
    const buffer = await assets.load(assetId, bytes);
    if (buffer !== null) loaded++;
  }
  return loaded;
}
