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
});
