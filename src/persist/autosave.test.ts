import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Command,
  CommandResult,
  DispatchOptions,
  DocumentChange,
  DocumentStore,
  HistoryEntry,
  Project,
  ProjectSnapshot,
  Unsub,
} from "../types";
import { AUTOSAVE_DEBOUNCE_MS } from "../types";
import { createAutosave } from "./autosave";
import { createProjectCodec } from "./codec";
import { createMemoryProjectStorage } from "./storage";
import { makeFixtureProject } from "./testing/fixture";

/** Minimal fake `DocumentStore`: only `getState`/`onChange`/`isDirty`/
 *  `markSaved` do anything real; everything else the interface requires is
 *  a harmless stub, since autosave never calls it. */
class FakeStore implements DocumentStore {
  private project: Project;
  private dirty = false;
  private readonly listeners = new Set<(change: DocumentChange) => void>();

  constructor(project: Project) {
    this.project = project;
  }

  getState(): ProjectSnapshot {
    return this.project as unknown as ProjectSnapshot;
  }

  /** Test helper: simulate a command landing (marks dirty, fires onChange). */
  edit(mutate: (p: Project) => void): void {
    mutate(this.project);
    this.dirty = true;
    const change: DocumentChange = {
      source: "command",
      label: "Test Edit",
      patches: [],
      inverse: [],
      doc: this.getState(),
    };
    for (const cb of this.listeners) cb(change);
  }

  dispatch(_command: Command, _options?: DispatchOptions): CommandResult {
    return { status: "noop" };
  }
  batch(_label: string, _commands: readonly Command[], _options?: DispatchOptions): CommandResult {
    return { status: "noop" };
  }
  undo(): HistoryEntry | null {
    return null;
  }
  redo(): HistoryEntry | null {
    return null;
  }
  canUndo(): boolean {
    return false;
  }
  canRedo(): boolean {
    return false;
  }
  undoLabel(): string | undefined {
    return undefined;
  }
  redoLabel(): string | undefined {
    return undefined;
  }
  clearHistory(): void {
    // no-op
  }
  onChange(cb: (change: DocumentChange) => void): Unsub {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  replaceDocument(project: Project): void {
    this.project = project;
    // The real store clears `dirty` here ("a freshly loaded document matches
    // what is on disk") and emits a `load` change; autosave has to notice
    // that the document under it was swapped.
    this.dirty = false;
    const change: DocumentChange = {
      source: "load",
      label: "Load Project",
      patches: [{ op: "replace", path: [], value: project }],
      inverse: [],
      doc: this.getState(),
    };
    for (const cb of this.listeners) cb(change);
  }
  isDirty(): boolean {
    return this.dirty;
  }
  markSaved(): void {
    this.dirty = false;
  }
}

describe("createAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write until the debounce elapses", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "Renamed";
    });
    expect(autosave.status.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(await storage.read(store.getState().id)).toBeNull();

    autosave.dispose();
  });

  it("writes once after the ~2s debounce and calls markSaved", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "Renamed";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    const written = await storage.read(store.getState().id);
    expect(written).not.toBeNull();
    expect(JSON.parse(written ?? "{}")).toMatchObject({ project: { name: "Renamed" } });
    expect(store.isDirty()).toBe(false);
    expect(autosave.status.state).toBe("saved");
    expect(autosave.status.lastSavedAt).not.toBeNull();

    autosave.dispose();
  });

  it("coalesces multiple edits inside one debounce window into a single write", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const writeSpy = vi.spyOn(storage, "write");
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "A";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS / 2);
    store.edit((p) => {
      p.name = "B";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS / 2);
    // Still within the window restarted by the second edit? No — the
    // contract is "one pending write regardless of how many commands land
    // inside the window", not a resetting debounce; assert exactly one
    // write once the full window from the first edit has elapsed.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = await storage.read(store.getState().id);
    expect(JSON.parse(written ?? "{}")).toMatchObject({ project: { name: "B" } });

    autosave.dispose();
  });

  it("notifies onStatusChange listeners through pending -> saving -> saved", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });
    const states: string[] = [];
    const unsub = autosave.onStatusChange((s) => states.push(s.state));

    store.edit((p) => {
      p.name = "Renamed";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(states).toEqual(["pending", "saving", "saved"]);
    unsub();
    autosave.dispose();
  });

  it("flush() writes immediately without waiting for the debounce", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "Renamed";
    });
    await autosave.flush();

    expect(await storage.read(store.getState().id)).not.toBeNull();
    expect(store.isDirty()).toBe(false);

    autosave.dispose();
  });

  it("flush() is a no-op when nothing is dirty", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const writeSpy = vi.spyOn(storage, "write");
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    await autosave.flush();
    expect(writeSpy).not.toHaveBeenCalled();

    autosave.dispose();
  });

  it("does not schedule anything when storage is unavailable", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    Object.defineProperty(storage, "available", { value: false });
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "Renamed";
    });
    expect(autosave.status.state).toBe("idle");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(autosave.status.state).toBe("idle");

    autosave.dispose();
  });

  it("dispose() stops future writes without flushing a pending edit", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "Renamed";
    });
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);

    expect(await storage.read(store.getState().id)).toBeNull();
  });

  it("respects a custom debounceMs option", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec }, { debounceMs: 500 });

    store.edit((p) => {
      p.name = "Renamed";
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(await storage.read(store.getState().id)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await storage.read(store.getState().id)).not.toBeNull();

    autosave.dispose();
  });

  it("uses a custom storage key when given one", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec }, { key: "custom-key" });

    store.edit((p) => {
      p.name = "Renamed";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(await storage.read("custom-key")).not.toBeNull();
    expect(await storage.read(store.getState().id)).toBeNull();

    autosave.dispose();
  });
  // --- SS13: the document can be REPLACED under a live autosave -------------

  it("writes a replaced document (New/Import) under ITS OWN key", async () => {
    const projectA = makeFixtureProject();
    const store = new FakeStore(projectA);
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    const projectB = { ...makeFixtureProject(), id: "prj-imported", name: "Imported Song" };
    store.replaceDocument(projectB);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    // The import landed in its own slot ("one slot per project id"), and the
    // project that was open before it is untouched.
    expect(await storage.list()).toEqual(["prj-imported"]);
    const written = await storage.read("prj-imported");
    expect(JSON.parse(written ?? "{}")).toMatchObject({ project: { name: "Imported Song" } });
    expect(await storage.read(projectA.id)).toBeNull();

    autosave.dispose();
  });

  it("keeps the previous project's slot intact when a new document replaces it", async () => {
    const projectA = makeFixtureProject();
    const store = new FakeStore(projectA);
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "A edited";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    store.replaceDocument({ ...makeFixtureProject(), id: "prj-b", name: "B" });
    store.edit((p) => {
      p.name = "B edited";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(JSON.parse((await storage.read(projectA.id)) ?? "{}")).toMatchObject({
      project: { name: "A edited" },
    });
    expect(JSON.parse((await storage.read("prj-b")) ?? "{}")).toMatchObject({
      project: { name: "B edited" },
    });
    // Newest-first, so a reopen resumes B (SS13 "resume the last autosave").
    expect((await storage.list())[0]).toBe("prj-b");

    autosave.dispose();
  });

  it("flush() persists a replaced document even though the store is not dirty", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });

    store.replaceDocument({ ...makeFixtureProject(), id: "prj-imported", name: "Imported Song" });
    expect(store.isDirty()).toBe(false);
    await autosave.flush();

    expect(await storage.read("prj-imported")).not.toBeNull();
    expect(autosave.status.state).toBe("saved");

    autosave.dispose();
  });

  // --- SS2 "byte-stable except for edits": nothing may be lost mid-write ----

  it("does not lose an edit that lands while a write is in flight", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const realWrite = storage.write.bind(storage);
    // A slow backend: the edit below lands while these bytes are in flight.
    vi.spyOn(storage, "write").mockImplementation(async (key, text) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await realWrite(key, text);
    });
    const autosave = createAutosave({ store, storage, codec });

    store.edit((p) => {
      p.name = "EDIT-A";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    store.edit((p) => {
      p.name = "EDIT-B";
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 200);

    expect(JSON.parse((await storage.read(store.getState().id)) ?? "{}")).toMatchObject({
      project: { name: "EDIT-B" },
    });
    expect(store.isDirty()).toBe(false);

    autosave.dispose();
  });

  // Rule 5: `flush()` is what New/Import call in the statement BEFORE
  // `replaceDocument`, so its payload has to be encoded synchronously — a
  // capture deferred behind an await encodes the INCOMING document under the
  // INCOMING id, and the outgoing project's slot is never written at all.
  it("captures its bytes synchronously, so a replace right after flush() cannot steal them", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const autosave = createAutosave({ store, storage, codec });
    const outgoingId = store.getState().id;

    store.edit((p) => {
      p.name = "OUTGOING EDIT";
    });
    // No debounce has fired: the edit lives only in the store.
    expect(await storage.read(outgoingId)).toBeNull();

    // Exactly what App.tsx's New/Import do — no await in between.
    const flushed = autosave.flush();
    store.replaceDocument({ ...makeFixtureProject(), id: "prj-incoming", name: "INCOMING" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
    await flushed;

    expect(JSON.parse((await storage.read(outgoingId)) ?? "{}")).toMatchObject({
      project: { name: "OUTGOING EDIT" },
    });
    // ...and the incoming document lands in its OWN slot (rule 1).
    expect(JSON.parse((await storage.read("prj-incoming")) ?? "{}")).toMatchObject({
      project: { name: "INCOMING" },
    });

    autosave.dispose();
  });

  // Rule 4: two writes to the same slot must not overlap. With a backend whose
  // latency depends on the payload, an unserialized autosave lets the SECOND
  // write finish first (and call `markSaved`), after which the FIRST lands and
  // overwrites the slot with the OLDER document — leaving stale bytes on disk
  // that nothing will ever rewrite, because the store is no longer dirty.
  it("never lets an older write land after a newer one", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const realWrite = storage.write.bind(storage);
    vi.spyOn(storage, "write").mockImplementation(async (key, text) => {
      // "A" is slow, "B" is fast: out-of-order completion, if allowed.
      await new Promise((resolve) => setTimeout(resolve, text.includes('"A"') ? 500 : 10));
      await realWrite(key, text);
    });
    const autosave = createAutosave({ store, storage, codec }, { debounceMs: 10 });

    store.edit((p) => {
      p.name = "A";
    });
    await vi.advanceTimersByTimeAsync(10); // write #1 ("A") starts, slowly
    store.edit((p) => {
      p.name = "B";
    });
    await vi.advanceTimersByTimeAsync(2000);
    await autosave.flush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(JSON.parse((await storage.read(store.getState().id)) ?? "{}")).toMatchObject({
      project: { name: "B" },
    });
    expect(store.isDirty()).toBe(false);

    autosave.dispose();
  });

  // A failed write must not park the document forever: the store stays dirty,
  // so autosave retries on a backoff instead of waiting for the user to make
  // another edit (SS13 — the app's only implicit save path).
  it("retries a failed write on a backoff", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const realWrite = storage.write.bind(storage);
    let failures = 0;
    vi.spyOn(storage, "write").mockImplementation(async (key, text) => {
      if (failures < 1) {
        failures += 1;
        throw new Error("QuotaExceeded");
      }
      await realWrite(key, text);
    });
    const autosave = createAutosave({ store, storage, codec }, { debounceMs: 10 });

    store.edit((p) => {
      p.name = "RETRIED";
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(autosave.status.state).toBe("error");
    expect(await storage.read(store.getState().id)).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(autosave.status.state).toBe("saved");
    expect(JSON.parse((await storage.read(store.getState().id)) ?? "{}")).toMatchObject({
      project: { name: "RETRIED" },
    });

    autosave.dispose();
  });

  it("gives up after a bounded number of failed retries", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    let attempts = 0;
    vi.spyOn(storage, "write").mockImplementation(async () => {
      attempts += 1;
      await Promise.resolve();
      throw new Error("nope");
    });
    const autosave = createAutosave({ store, storage, codec }, { debounceMs: 10 });

    store.edit((p) => {
      p.name = "DOOMED";
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(autosave.status.state).toBe("error");
    // The first attempt plus a bounded number of retries — never a spin.
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(4);

    autosave.dispose();
  });

  it("flush() writes the newest state even when it arrives mid-write", async () => {
    const store = new FakeStore(makeFixtureProject());
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const realWrite = storage.write.bind(storage);
    vi.spyOn(storage, "write").mockImplementation(async (key, text) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await realWrite(key, text);
    });
    const autosave = createAutosave({ store, storage, codec }, { debounceMs: 10 });

    store.edit((p) => {
      p.name = "A";
    });
    await vi.advanceTimersByTimeAsync(10); // the write for "A" is now in flight
    store.edit((p) => {
      p.name = "B";
    });
    const flushed = autosave.flush();
    await vi.advanceTimersByTimeAsync(200);
    await flushed;

    expect(JSON.parse((await storage.read(store.getState().id)) ?? "{}")).toMatchObject({
      project: { name: "B" },
    });
    expect(store.isDirty()).toBe(false);

    autosave.dispose();
  });
});
