import { describe, expect, it } from "vitest";
import { createProjectCodec } from "./codec";
import {
  exportProjectBlob,
  importProjectFile,
  importProjectText,
  projectFileName,
  readBlobText,
} from "./importExport";
import { makeFixtureProject } from "./testing/fixture";

describe("projectFileName", () => {
  it("uses the project name", () => {
    const project = makeFixtureProject();
    expect(projectFileName(project)).toBe("Fixture Song.json");
  });

  it("falls back to untitled.json for a blank name", () => {
    const project = { ...makeFixtureProject(), name: "   " };
    expect(projectFileName(project)).toBe("untitled.json");
  });

  it("strips filesystem-unsafe characters", () => {
    const project = { ...makeFixtureProject(), name: 'My/Song:Take*2?"<>|' };
    expect(projectFileName(project)).not.toMatch(/[\\/:*?"<>|]/);
    expect(projectFileName(project).endsWith(".json")).toBe(true);
  });
});

describe("export/import round trip", () => {
  it("exportProjectBlob -> importProjectFile reproduces the project", async () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const blob = exportProjectBlob(codec, project, { savedAt: "2026-01-01T00:00:00.000Z" });
    expect(blob.type).toBe("application/json");

    const result = await importProjectFile(codec, blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.id).toBe(project.id);
    expect(result.warnings).toEqual([]);
  });

  it("importProjectText surfaces a decode failure for garbage input", () => {
    const codec = createProjectCodec();
    const result = importProjectText(codec, "not json at all");
    expect(result.ok).toBe(false);
  });

  it("exportProjectBlob defaults to pretty-printed JSON", async () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const blob = exportProjectBlob(codec, project, { savedAt: "2026-01-01T00:00:00.000Z" });
    const text = await readBlobText(blob);
    expect(text).toContain("\n");
  });
});
