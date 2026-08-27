// SS15: "no browser needed for any of the load-bearing logic." The SHIPPED
// backend (`createOpfsProjectStorage`, wired by src/app/persistence.ts) is
// load-bearing — key encoding, the NotFoundError -> null mapping, the cached
// directory handle, and above all `list()`'s newest-first ordering, which is
// what SS13's "resume the last autosave" reads through
// `loadOrCreateProject`. All of it runs headlessly against the small fake
// `navigator.storage` below; only the browser's own OPFS implementation is
// left to the one Playwright spec.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpfsProjectStorage } from "./storage";

// --- a minimal in-memory File System Access API ----------------------------

class FakeFile {
  constructor(
    private readonly text_: string,
    readonly lastModified: number,
  ) {}
  text(): Promise<string> {
    return Promise.resolve(this.text_);
  }
}

function notFound(): DOMException {
  return new DOMException("not found", "NotFoundError");
}

class FakeFileHandle {
  readonly kind = "file";
  constructor(
    readonly name: string,
    private readonly dir: FakeDirectoryHandle,
  ) {}
  getFile(): Promise<FakeFile> {
    const entry = this.dir.files.get(this.name);
    if (entry === undefined) return Promise.reject(notFound());
    return Promise.resolve(new FakeFile(entry.text, entry.at));
  }
  createWritable(): Promise<{ write(text: string): Promise<void>; close(): Promise<void> }> {
    let buffer = "";
    return Promise.resolve({
      write: (text: string) => {
        buffer += text;
        return Promise.resolve();
      },
      close: () => {
        this.dir.files.set(this.name, { text: buffer, at: this.dir.clock() });
        return Promise.resolve();
      },
    });
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory";
  readonly files = new Map<string, { text: string; at: number }>();
  readonly children = new Map<string, FakeDirectoryHandle>();
  /** Iteration order is deliberately NOT write order (see `values`). */
  reverseIteration = true;
  private now = 1000;

  constructor(readonly name = "") {}

  clock(): number {
    this.now += 1000;
    return this.now;
  }

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing !== undefined) return Promise.resolve(existing);
    if (options?.create !== true) return Promise.reject(notFound());
    const child = new FakeDirectoryHandle(name);
    this.children.set(name, child);
    return Promise.resolve(child);
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (options?.create !== true) return Promise.reject(notFound());
      this.files.set(name, { text: "", at: this.clock() });
    }
    return Promise.resolve(new FakeFileHandle(name, this));
  }

  removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) return Promise.reject(notFound());
    return Promise.resolve();
  }

  async *values(): AsyncIterableIterator<FakeFileHandle> {
    const names = [...this.files.keys()];
    if (this.reverseIteration) names.reverse();
    for (const name of names) yield new FakeFileHandle(name, this);
  }
}

interface FakeOpfs {
  root: FakeDirectoryHandle;
  getDirectoryCalls: number;
}

function installFakeOpfs(): FakeOpfs {
  const root = new FakeDirectoryHandle();
  const fake: FakeOpfs = { root, getDirectoryCalls: 0 };
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: () => {
        fake.getDirectoryCalls += 1;
        return Promise.resolve(root);
      },
    },
  });
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpfsProjectStorage", () => {
  it("reports unavailable (and stays harmless) without navigator.storage", async () => {
    vi.stubGlobal("navigator", {});
    const storage = createOpfsProjectStorage();
    expect(storage.kind).toBe("opfs");
    expect(storage.available).toBe(false);
    await expect(storage.read("prj-1")).resolves.toBeNull();
    await expect(storage.list()).resolves.toEqual([]);
    await expect(storage.remove("prj-1")).resolves.toBeUndefined();
    await expect(storage.write("prj-1", "{}")).rejects.toThrow(/not available/i);
  });

  it("round-trips write -> read and overwrites in place", async () => {
    installFakeOpfs();
    const storage = createOpfsProjectStorage();
    await storage.write("prj-1", '{"a":1}');
    await expect(storage.read("prj-1")).resolves.toBe('{"a":1}');
    await storage.write("prj-1", '{"a":2}');
    await expect(storage.read("prj-1")).resolves.toBe('{"a":2}');
  });

  it("maps a missing file to null instead of throwing", async () => {
    installFakeOpfs();
    const storage = createOpfsProjectStorage();
    await expect(storage.read("never-written")).resolves.toBeNull();
    await expect(storage.remove("never-written")).resolves.toBeUndefined();
  });

  it("encodes keys that are not safe file names, and decodes them back", async () => {
    const fake = installFakeOpfs();
    const storage = createOpfsProjectStorage();
    const key = "prj a/b?c";
    await storage.write(key, "{}");
    const dir = await fake.root.getDirectoryHandle("fableton-projects");
    expect([...dir.files.keys()]).toEqual(["prj%20a%2Fb%3Fc.json"]);
    await expect(storage.read(key)).resolves.toBe("{}");
    await expect(storage.list()).resolves.toEqual([key]);
  });

  it("list() reports keys newest-first, whatever order the directory yields", async () => {
    installFakeOpfs();
    const storage = createOpfsProjectStorage();
    await storage.write("prj-old", "{}");
    await storage.write("prj-mid", "{}");
    await storage.write("prj-new", "{}");
    // SS13's "resume the last autosave" is `list()[0]`; the fake iterates in
    // reverse write order precisely so a passing test cannot be an accident
    // of iteration order.
    await expect(storage.list()).resolves.toEqual(["prj-new", "prj-mid", "prj-old"]);

    await storage.write("prj-old", "{}"); // touched: now the newest
    await expect(storage.list()).resolves.toEqual(["prj-old", "prj-new", "prj-mid"]);
  });

  it("list() ignores non-.json entries", async () => {
    const fake = installFakeOpfs();
    const storage = createOpfsProjectStorage();
    await storage.write("prj-1", "{}");
    const dir = await fake.root.getDirectoryHandle("fableton-projects");
    dir.files.set("notes.txt", { text: "hi", at: 99_000 });
    await expect(storage.list()).resolves.toEqual(["prj-1"]);
  });

  it("resolves the projects directory once and caches the handle", async () => {
    const fake = installFakeOpfs();
    const storage = createOpfsProjectStorage();
    await storage.write("prj-1", "{}");
    await storage.read("prj-1");
    await storage.list();
    expect(fake.getDirectoryCalls).toBe(1);
  });

  it("honours a custom subdir", async () => {
    const fake = installFakeOpfs();
    const storage = createOpfsProjectStorage({ subdir: "somewhere-else" });
    await storage.write("prj-1", "{}");
    expect([...fake.root.children.keys()]).toEqual(["somewhere-else"]);
  });
});
