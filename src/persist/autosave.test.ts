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
    this.dirty = false;
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
});
