import { describe, expect, it, vi } from "vitest";
import type { CreateEmptyProject } from "../types";
import { createProjectCodec } from "./codec";
import { loadOrCreateProject } from "./loadOrCreate";
import { createMemoryProjectStorage } from "./storage";
import { makeFixtureProject } from "./testing/fixture";

/** A tiny fake standing in for `command-undo`'s real `createEmptyProject` —
 *  this package never imports that concurrently-written implementation. */
const fakeCreateEmptyProject: CreateEmptyProject = (options) => ({
  ...makeFixtureProject(),
  id: "fresh-project",
  name: options?.name ?? "Untitled",
});

describe("loadOrCreateProject", () => {
  it("creates a fresh project when storage has nothing at all", async () => {
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const result = await loadOrCreateProject(storage, codec, {
      key: "proj-1",
      createEmptyProject: fakeCreateEmptyProject,
    });
    expect(result.source).toBe("created");
    expect(result.project.id).toBe("fresh-project");
    expect(result.warnings).toEqual([]);
    expect(result.loadError).toBeUndefined();
  });

  it("resumes a stored project when the key is given explicitly", async () => {
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    await storage.write(project.id, codec.encode(project));

    const result = await loadOrCreateProject(storage, codec, {
      key: project.id,
      createEmptyProject: fakeCreateEmptyProject,
    });
    expect(result.source).toBe("storage");
    expect(result.project.id).toBe(project.id);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the newest key when none is given", async () => {
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const older = { ...makeFixtureProject(), id: "older" };
    const newer = { ...makeFixtureProject(), id: "newer" };
    await storage.write(older.id, codec.encode(older));
    await storage.write(newer.id, codec.encode(newer));

    const result = await loadOrCreateProject(storage, codec, { createEmptyProject: fakeCreateEmptyProject });
    expect(result.source).toBe("storage");
    expect(result.project.id).toBe("newer");
  });

  it("falls back to a fresh project and reports loadError when the stored file is corrupt", async () => {
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    await storage.write("proj-1", "not valid json");

    const result = await loadOrCreateProject(storage, codec, {
      key: "proj-1",
      createEmptyProject: fakeCreateEmptyProject,
    });
    expect(result.source).toBe("created");
    expect(result.loadError).toBeDefined();
  });

  it("creates a fresh project without touching storage when storage is unavailable", async () => {
    const storage = createMemoryProjectStorage();
    Object.defineProperty(storage, "available", { value: false });
    const readSpy = vi.spyOn(storage, "read");
    const codec = createProjectCodec();

    const result = await loadOrCreateProject(storage, codec, { createEmptyProject: fakeCreateEmptyProject });
    expect(result.source).toBe("created");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("passes newProjectName through to createEmptyProject", async () => {
    const storage = createMemoryProjectStorage();
    const codec = createProjectCodec();
    const result = await loadOrCreateProject(storage, codec, {
      key: "missing",
      createEmptyProject: fakeCreateEmptyProject,
      newProjectName: "My New Song",
    });
    expect(result.project.name).toBe("My New Song");
  });
});
