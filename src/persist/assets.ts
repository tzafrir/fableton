// Where an imported audio file's BYTES live (SS13, extended).
//
// The document holds only the reference (`AssetId`) and the metadata: it is a
// plain JSON value that is structurally cloned into every undo entry and
// re-serialised on every autosave, so a two-second sample inside it would
// cost more per keystroke than the whole rest of the song. The samples
// therefore sit beside the project in the SAME `ProjectStorage` — one slot
// per asset, under a reserved key prefix.
//
// `ProjectStorage` is a TEXT store (SS13 named it for JSON), so the bytes are
// base64. That is a 33% size tax, paid to avoid a second storage backend and
// a second set of fallbacks for a browser that has one and not the other. If
// sample libraries ever get big enough for that to matter, the fix is a
// binary sibling of `ProjectStorage`, not a change here.

import type { AssetId, ProjectStorage } from "../types";

/**
 * Reserved key prefix. `loadOrCreateProject` picks the newest key in storage
 * as "the project", so asset slots MUST be distinguishable from project
 * slots — otherwise importing a sample would make the app try to open it as
 * a song on the next reload.
 */
export const ASSET_KEY_PREFIX = "asset:";

export function assetStorageKey(assetId: AssetId): string {
  return `${ASSET_KEY_PREFIX}${assetId}`;
}

export function isAssetKey(key: string): boolean {
  return key.startsWith(ASSET_KEY_PREFIX);
}

/** Chunked so a multi-megabyte sample does not blow the argument limit of
 *  `String.fromCharCode` — the classic way base64 encoders break, and only
 *  ever on the files big enough to matter. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface AssetStore {
  /** Writes the encoded file (a `.wav`'s own bytes, undecoded). */
  put(assetId: AssetId, bytes: ArrayBuffer): Promise<void>;
  /** The bytes as written, or `null` if this slot is empty. */
  get(assetId: AssetId): Promise<ArrayBuffer | null>;
  remove(assetId: AssetId): Promise<void>;
  /** Every asset id currently in storage. */
  list(): Promise<readonly AssetId[]>;
}

export function createAssetStore(storage: ProjectStorage): AssetStore {
  return {
    async put(assetId: AssetId, bytes: ArrayBuffer): Promise<void> {
      await storage.write(assetStorageKey(assetId), bytesToBase64(new Uint8Array(bytes)));
    },

    async get(assetId: AssetId): Promise<ArrayBuffer | null> {
      const text = await storage.read(assetStorageKey(assetId));
      if (text === null) return null;
      const bytes = base64ToBytes(text);
      // A fresh, exactly-sized buffer: `decodeAudioData` DETACHES what it is
      // given, and a view into a larger pool would take the pool with it.
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },

    async remove(assetId: AssetId): Promise<void> {
      await storage.remove(assetStorageKey(assetId));
    },

    async list(): Promise<readonly AssetId[]> {
      const keys = await storage.list();
      return keys.filter(isAssetKey).map((key) => key.slice(ASSET_KEY_PREFIX.length));
    },
  };
}
