// SS2 — "A project must survive open -> edit -> save -> reopen byte-stable
// except for edits." This is that test, headless, against the in-memory
// `ProjectStorage` double (the "in-memory OPFS stub" the M1 persistence
// work package calls for).

import { describe, expect, it } from "vitest";
import type { JsonValue } from "../types";
import { createProjectCodec } from "./codec";
import { createMemoryProjectStorage } from "./storage";
import { cloneProject, makeFixtureProject } from "./testing/fixture";

const FIXED_SAVED_AT = "2026-08-27T00:00:00.000Z"; // pinned per EncodeOptions.savedAt's own doc comment

/** Every leaf path at which `a` and `b` differ (dotted/bracket JSON paths). */
function diffPaths(a: JsonValue, b: JsonValue, prefix = ""): string[] {
  if (a === b) return [];
  const aIsObj = typeof a === "object" && a !== null;
  const bIsObj = typeof b === "object" && b !== null;
  if (!aIsObj || !bIsObj || Array.isArray(a) !== Array.isArray(b)) {
    return [prefix || "$"];
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [prefix || "$"];
    const diffs: string[] = [];
    for (let i = 0; i < a.length; i++) diffs.push(...diffPaths(a[i]!, b[i]!, `${prefix}[${i}]`));
    return diffs;
  }
  const ao = a as { [k: string]: JsonValue };
  const bo = b as { [k: string]: JsonValue };
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  const diffs: string[] = [];
  for (const key of keys) {
    const av = ao[key];
    const bv = bo[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (av === undefined || bv === undefined) {
      diffs.push(path);
    } else {
      diffs.push(...diffPaths(av, bv, path));
    }
  }
  return diffs;
}

describe("open -> edit -> save -> reopen", () => {
  it("is byte-stable when no edit happens between save and reopen", async () => {
    const codec = createProjectCodec();
    const storage = createMemoryProjectStorage();
    const project = makeFixtureProject();

    // save
    const savedText = codec.encode(project, { savedAt: FIXED_SAVED_AT, pretty: false });
    await storage.write(project.id, savedText);

    // open (reopen #1)
    const reopened = codec.decode((await storage.read(project.id)) ?? "");
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.warnings).toEqual([]);

    // save again with no edits, reopen again
    const resavedText = codec.encode(reopened.project, { savedAt: FIXED_SAVED_AT, pretty: false });
    await storage.write(project.id, resavedText);
    const reopenedAgain = codec.decode((await storage.read(project.id)) ?? "");
    expect(reopenedAgain.ok).toBe(true);

    // Byte-for-byte identical: open -> save -> reopen -> save reproduces
    // the exact same file when nothing changed.
    expect(resavedText).toBe(savedText);
  });

  it("changes ONLY the edited fields once round-tripped through storage", async () => {
    const codec = createProjectCodec();
    const storage = createMemoryProjectStorage();
    const project = makeFixtureProject();

    // save -> open
    await storage.write(project.id, codec.encode(project, { savedAt: FIXED_SAVED_AT, pretty: false }));
    const opened = codec.decode((await storage.read(project.id)) ?? "");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // edit: rename the project and bump one note's velocity
    const edited = cloneProject(opened.project);
    edited.name = "Renamed Song";
    const clipId = Object.keys(edited.clips)[0];
    const clip = clipId ? edited.clips[clipId] : undefined;
    const note = clip?.notes[0];
    if (note) note.vel = 42;

    // save -> reopen
    const editedText = codec.encode(edited, { savedAt: FIXED_SAVED_AT, pretty: false });
    await storage.write(project.id, editedText);
    const reopened = codec.decode((await storage.read(project.id)) ?? "");
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    // Compare the two saved envelopes: every difference must trace back to
    // one of the two edits actually made.
    const before = JSON.parse(codec.encode(opened.project, { savedAt: FIXED_SAVED_AT, pretty: false })) as JsonValue;
    const after = JSON.parse(editedText) as JsonValue;
    const paths = diffPaths(before, after);

    expect(reopened.project.name).toBe("Renamed Song");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const isNameEdit = path === "project.name";
      const isVelEdit = /^project\.clips\..*\.notes\[0\]\.vel$/.test(path);
      expect(isNameEdit || isVelEdit).toBe(true);
    }

    // Everything else survived the whole open -> edit -> save -> reopen
    // cycle unchanged.
    expect(reopened.project.tempo).toEqual(opened.project.tempo);
    expect(reopened.project.channels).toEqual(opened.project.channels);
    expect(reopened.project.channelOrder).toEqual(opened.project.channelOrder);
    expect(reopened.project.paramValues).toEqual(opened.project.paramValues);
    expect(reopened.project.sidechains).toEqual(opened.project.sidechains);
  });

  it("survives multiple save/reopen cycles without drifting", async () => {
    const codec = createProjectCodec();
    const storage = createMemoryProjectStorage();
    let project = makeFixtureProject();

    for (let i = 0; i < 5; i++) {
      await storage.write(project.id, codec.encode(project, { savedAt: FIXED_SAVED_AT, pretty: false }));
      const result = codec.decode((await storage.read(project.id)) ?? "");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
      project = result.project;
    }

    const finalText = codec.encode(project, { savedAt: FIXED_SAVED_AT, pretty: false });
    const firstText = codec.encode(makeFixtureProject(), { savedAt: FIXED_SAVED_AT, pretty: false });
    expect(finalText).toBe(firstText);
  });
});
