// SS7 `DeviceServices.assets` — decoded audio, keyed by `AssetId`.
//
// One library per audio context, owned by the engine and handed to the device
// host. Devices read `buffer(id)` (a map lookup, safe per note) and subscribe
// to `onChange`, so a sampler that mounted before its file finished decoding
// picks it up when it lands.
//
// Decoding is the app shell's job to START (it is the only layer that knows
// which assets the document references and can read the store) and this
// library's job to HOLD. Nothing here touches storage or the document.

import type { AssetId, AssetLibrary, Unsub } from "../../types";

export interface AppAssetLibrary extends AssetLibrary {
  /**
   * Decodes `bytes` and holds the result under `assetId`. Resolves with the
   * buffer, or `null` when the file could not be decoded — a corrupt or
   * unsupported file is a normal outcome (the user picked it), not something
   * to throw at the app shell.
   *
   * The bytes are COPIED before decoding: `decodeAudioData` detaches what it
   * is given, and the caller may still want its own copy (to write to the
   * store, for one).
   */
  load(assetId: AssetId, bytes: ArrayBuffer): Promise<AudioBuffer | null>;
  /** True once `load` has resolved for this id, successfully or not. */
  has(assetId: AssetId): boolean;
  drop(assetId: AssetId): void;
  /** Ids currently held. */
  ids(): readonly AssetId[];
  dispose(): void;
}

export function createAssetLibrary(ctx: BaseAudioContext): AppAssetLibrary {
  const buffers = new Map<AssetId, AudioBuffer | null>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const notify = (): void => {
    for (const cb of [...listeners]) cb();
  };

  return {
    buffer(assetId: AssetId): AudioBuffer | undefined {
      return buffers.get(assetId) ?? undefined;
    },

    onChange(cb: () => void): Unsub {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async load(assetId: AssetId, bytes: ArrayBuffer): Promise<AudioBuffer | null> {
      if (disposed) return null;
      const decode = (ctx as { decodeAudioData?: (b: ArrayBuffer) => Promise<AudioBuffer> })
        .decodeAudioData;
      if (typeof decode !== "function") return null;
      let buffer: AudioBuffer | null = null;
      try {
        buffer = await decode.call(ctx, bytes.slice(0));
      } catch {
        buffer = null;
      }
      if (disposed) return null;
      // Recorded even on failure: `has` is what stops the shell re-reading and
      // re-decoding a file that will never decode, on every document change.
      buffers.set(assetId, buffer);
      notify();
      return buffer;
    },

    has(assetId: AssetId): boolean {
      return buffers.has(assetId);
    },

    drop(assetId: AssetId): void {
      if (!buffers.delete(assetId)) return;
      notify();
    },

    ids(): readonly AssetId[] {
      return [...buffers.keys()];
    },

    dispose(): void {
      disposed = true;
      buffers.clear();
      listeners.clear();
    },
  };
}
