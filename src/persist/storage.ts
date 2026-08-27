// SS13 — `ProjectStorage`: "Where autosave puts bytes. One slot per project
// id; the implementation is OPFS (`navigator.storage.getDirectory()`), and
// the in-memory double is what unit tests use."
//
// Two implementations, same interface: `createMemoryProjectStorage` (the
// headless double — no browser APIs, safe under Vitest/Node) and
// `createOpfsProjectStorage` (the real backend). Neither is preferred by
// this module; the app-shell picks one at startup and falls back to the
// memory double (or just runs without autosave, per `available`) when OPFS
// is missing.

import type { ProjectStorage } from "../types";

// -----------------------------------------------------------------------
// in-memory double
// -----------------------------------------------------------------------

/**
 * Headless `ProjectStorage`. Keeps everything in a `Map`; `list()` returns
 * keys newest-write-first, which the real OPFS backend cannot promise but
 * this one can, for free.
 */
export function createMemoryProjectStorage(): ProjectStorage {
  const texts = new Map<string, string>();
  const writeOrder: string[] = []; // most-recently-written first

  function touch(key: string): void {
    const idx = writeOrder.indexOf(key);
    if (idx >= 0) writeOrder.splice(idx, 1);
    writeOrder.unshift(key);
  }

  return {
    kind: "memory",
    available: true,
    read(key: string): Promise<string | null> {
      return Promise.resolve(texts.has(key) ? (texts.get(key) ?? null) : null);
    },
    write(key: string, text: string): Promise<void> {
      texts.set(key, text);
      touch(key);
      return Promise.resolve();
    },
    remove(key: string): Promise<void> {
      texts.delete(key);
      const idx = writeOrder.indexOf(key);
      if (idx >= 0) writeOrder.splice(idx, 1);
      return Promise.resolve();
    },
    list(): Promise<readonly string[]> {
      return Promise.resolve([...writeOrder]);
    },
  };
}

// -----------------------------------------------------------------------
// OPFS
// -----------------------------------------------------------------------

/** Not yet in TS's bundled `lib.dom.d.ts` (the File System Access API's
 *  async-iteration extension on directory handles); declared locally and
 *  reached only via a runtime cast in `list()` below. */
interface AsyncIterableDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage !== "undefined" &&
    typeof navigator.storage.getDirectory === "function"
  );
}

function encodeFileName(key: string): string {
  return `${encodeURIComponent(key)}.json`;
}

function decodeFileName(fileName: string): string {
  return decodeURIComponent(fileName.slice(0, -".json".length));
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}

export interface OpfsProjectStorageOptions {
  /** Subdirectory of the OPFS root projects live under. */
  readonly subdir?: string | undefined;
}

/** Real backend: one `.json` file per key under a private OPFS subdirectory.
 *  `available` is computed once, synchronously, at creation — SS13: "the
 *  app must still run, just without autosave" when it's false. */
export function createOpfsProjectStorage(options?: OpfsProjectStorageOptions): ProjectStorage {
  const subdir = options?.subdir ?? "fableton-projects";
  const available = opfsAvailable();
  let dirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  function getDir(): Promise<FileSystemDirectoryHandle> {
    dirPromise ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(subdir, { create: true }));
    return dirPromise;
  }

  return {
    kind: "opfs",
    available,
    async read(key: string): Promise<string | null> {
      if (!available) return null;
      try {
        const dir = await getDir();
        const handle = await dir.getFileHandle(encodeFileName(key));
        const file = await handle.getFile();
        return await file.text();
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async write(key: string, text: string): Promise<void> {
      if (!available) throw new Error("OPFS is not available in this browser.");
      const dir = await getDir();
      const handle = await dir.getFileHandle(encodeFileName(key), { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
    async remove(key: string): Promise<void> {
      if (!available) return;
      try {
        const dir = await getDir();
        await dir.removeEntry(encodeFileName(key));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
    async list(): Promise<readonly string[]> {
      if (!available) return [];
      const dir = (await getDir()) as unknown as AsyncIterableDirectoryHandle;
      const keys: string[] = [];
      for await (const entry of dir.values()) {
        if (entry.kind === "file" && entry.name.endsWith(".json")) keys.push(decodeFileName(entry.name));
      }
      return keys;
    },
  };
}
