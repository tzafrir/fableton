// SS13 — the app shell's startup + autosave wiring, headless: the in-memory
// `ProjectStorage` double (SS15's "no browser needed") stands in for OPFS.

import { describe, expect, it } from "vitest";
import { createMemoryProjectStorage, projectCodec } from "../persist";
import { createEmptyProject, createProjectCommands } from "../state";
import { bootstrapProject } from "./persistence";

describe("bootstrapProject", () => {
  it("creates a fresh project when storage has nothing saved", async () => {
    const storage = createMemoryProjectStorage();
    const { store, loadResult, autosave } = await bootstrapProject(storage, {
      createProject: createEmptyProject,
    });

    expect(loadResult.source).toBe("created");
    expect(store.getState().name).toBe("Untitled");
    autosave.dispose();
  });

  // SS3/SS18-M1: the audible path now runs off the document, so the document
  // a first run opens has to CONTAIN something — an empty starting clip meant
  // Boot -> Play was silent and the migration was only half done.
  it("falls back to the audible starter project by default", async () => {
    const storage = createMemoryProjectStorage();
    const { store, loadResult, autosave } = await bootstrapProject(storage);

    expect(loadResult.source).toBe("created");
    const doc = store.getState();
    expect(doc.name).toBe("Demo Phrase");

    const clips = Object.values(doc.clips);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.notes.length).toBeGreaterThan(0);

    // ...and that clip's track really names an instrument the engine can
    // mount, or the notes would still be silent.
    const track = doc.channels[clips[0]!.trackId]!;
    expect(track.source?.kind).toBe("instrument");
    expect(doc.devices[(track.source as { deviceId: string }).deviceId]).toBeDefined();

    autosave.dispose();
  });

  it("resumes the newest autosave when one exists", async () => {
    const storage = createMemoryProjectStorage();
    const seed = await bootstrapProject(storage);
    seed.autosave.dispose();
    // A fresh project starts clean (not dirty) — force a write directly so
    // this test does not depend on autosave's own debounce timing.
    const project = seed.store.getState() as unknown as import("../types").Project;
    await storage.write(project.id, projectCodec.encode(project));

    const resumed = await bootstrapProject(storage);
    expect(resumed.loadResult.source).toBe("storage");
    expect(resumed.store.getState().id).toBe(seed.store.getState().id);
    resumed.autosave.dispose();
  });

  it("wires autosave to the store: a dispatched command schedules a pending write", async () => {
    const storage = createMemoryProjectStorage();
    const { store, autosave } = await bootstrapProject(storage);
    expect(autosave.status.state).toBe("idle");

    const commands = createProjectCommands();
    store.dispatch(commands.renameProject("Renamed"));

    expect(autosave.status.state).toBe("pending");
    expect(store.isDirty()).toBe(true);

    await autosave.flush();
    expect(autosave.status.state).toBe("saved");
    expect(store.isDirty()).toBe(false);
    expect(await storage.read(store.getState().id)).not.toBeNull();

    autosave.dispose();
  });

  // --- SS2's "open -> edit -> save -> reopen", document-REPLACEMENT flavour --
  //
  // App.tsx's New and Import both go through `store.replaceDocument`, which
  // clears the store's dirty flag ("a freshly loaded document matches what is
  // on disk"). That is true of the FILE it came from and false of this app's
  // OPFS slot, so these two tests are the round trip nothing else covers:
  // the document a user imports (or starts fresh) must be the one that comes
  // back after a reload, in its OWN slot.

  it("persists an IMPORTED document and reopens it, leaving the old slot intact", async () => {
    const storage = createMemoryProjectStorage();
    const first = await bootstrapProject(storage);
    const starterId = first.store.getState().id;
    first.store.dispatch(createProjectCommands().renameProject("Starter"));
    await first.autosave.flush();

    const imported = { ...createEmptyProject(), name: "Imported Song" };
    first.store.replaceDocument(imported);
    await first.autosave.flush();
    first.autosave.dispose();

    expect(await storage.read(imported.id)).not.toBeNull();

    const reopened = await bootstrapProject(storage);
    expect(reopened.loadResult.source).toBe("storage");
    expect(reopened.store.getState().name).toBe("Imported Song");
    expect(reopened.store.getState().id).toBe(imported.id);
    // "One slot per project id" (types/persist.ts): the project that was open
    // before the import still has its own, unclobbered slot.
    expect(JSON.parse((await storage.read(starterId)) ?? "{}")).toMatchObject({
      project: { name: "Starter" },
    });
    reopened.autosave.dispose();
  });

  it("persists a NEW project and reopens it after further edits", async () => {
    const storage = createMemoryProjectStorage();
    const first = await bootstrapProject(storage);
    first.store.replaceDocument(createEmptyProject({ name: "Fresh" }));
    first.store.dispatch(createProjectCommands().renameProject("Fresh Edited"));
    await first.autosave.flush();
    const freshId = first.store.getState().id;
    first.autosave.dispose();

    const reopened = await bootstrapProject(storage);
    expect(reopened.store.getState().id).toBe(freshId);
    expect(reopened.store.getState().name).toBe("Fresh Edited");
    // ...and the reopened session autosaves back into the SAME slot.
    reopened.store.dispatch(createProjectCommands().renameProject("Fresh Again"));
    await reopened.autosave.flush();
    expect(await storage.list()).toContain(freshId);
    expect(JSON.parse((await storage.read(freshId)) ?? "{}")).toMatchObject({
      project: { name: "Fresh Again" },
    });
    reopened.autosave.dispose();
  });
});
