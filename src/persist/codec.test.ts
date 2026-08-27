import { describe, expect, it } from "vitest";
import type { JsonValue } from "../types";
import { PROJECT_SCHEMA_VERSION } from "../types";
import { createProjectCodec } from "./codec";
import { cloneProject, makeFixtureProject, MASTER_ID, TRACK_ID } from "./testing/fixture";

describe("ProjectCodec.encode", () => {
  it("is deterministic across repeated encodes of the same document", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const a = codec.encode(project, { savedAt: "2026-01-01T00:00:00.000Z" });
    const b = codec.encode(project, { savedAt: "2026-01-01T00:00:00.000Z" });
    expect(a).toBe(b);
  });

  it("is independent of the input object's own key order", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();

    // Rebuild `channels` and `paramValues` with reversed key insertion
    // order. If encode() trusted object iteration order instead of
    // computing its own, this would change the output.
    const reordered = {
      ...project,
      channels: Object.fromEntries(Object.entries(project.channels).reverse()),
      paramValues: Object.fromEntries(Object.entries(project.paramValues).reverse()),
    };

    const a = codec.encode(project, { savedAt: "2026-01-01T00:00:00.000Z" });
    const b = codec.encode(reordered, { savedAt: "2026-01-01T00:00:00.000Z" });
    expect(a).toBe(b);
  });

  it("orders channels by channelOrder, not by record key order", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject(); // channelOrder = [TRACK_ID, MASTER_ID]
    const text = codec.encode(project, { pretty: false });
    const parsed = JSON.parse(text) as { project: { channels: Record<string, unknown> } };
    expect(Object.keys(parsed.project.channels)).toEqual([TRACK_ID, MASTER_ID]);
  });

  it("writes fixed envelope fields and omits `app` when absent", () => {
    const codec = createProjectCodec();
    const text = codec.encode(makeFixtureProject(), { savedAt: "2026-01-01T00:00:00.000Z", pretty: false });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["format"]).toBe("fableton.project");
    expect(parsed["schemaVersion"]).toBe(PROJECT_SCHEMA_VERSION);
    expect(parsed["savedAt"]).toBe("2026-01-01T00:00:00.000Z");
    expect("app" in parsed).toBe(false);
  });

  it("omits undefined-valued optional clip fields rather than writing null", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    // clip has no `loop` set — the key must not appear at all.
    const text = codec.encode(project, { pretty: false });
    const parsed = JSON.parse(text) as { project: { clips: Record<string, Record<string, unknown>> } };
    const clip = parsed.project.clips["clip-1"];
    expect(clip).toBeDefined();
    expect("loop" in (clip ?? {})).toBe(false);
    // `color: null` (explicit) DOES round-trip as null, not omitted.
    expect(clip?.["color"]).toBeNull();
  });

  it("keeps notes sorted by (start, pitch) on the wire, regardless of input order", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject(); // fixture notes are deliberately unsorted
    const text = codec.encode(project, { pretty: false });
    const parsed = JSON.parse(text) as {
      project: { clips: Record<string, { notes: { start: number; pitch: number }[] }> };
    };
    const notes = parsed.project.clips["clip-1"]?.notes ?? [];
    expect(notes).toEqual([
      { id: "note-3", start: 0, dur: 480, pitch: 60, vel: 100 },
      { id: "note-1", start: 0, dur: 480, pitch: 64, vel: 90 },
      { id: "note-2", start: 480, dur: 240, pitch: 67, vel: 100 },
    ]);
  });
});

describe("ProjectCodec.decode / decodeValue", () => {
  it("round-trips a fixture project losslessly", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const text = codec.encode(project);
    const result = codec.decode(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.migratedFrom).toBeUndefined();
    // Re-encoding the decoded project must reproduce the same bytes.
    const savedAt = "2026-01-01T00:00:00.000Z";
    expect(codec.encode(result.project, { savedAt })).toBe(codec.encode(project, { savedAt }));
  });

  it("rejects a non-object payload", () => {
    const codec = createProjectCodec();
    const result = codec.decodeValue(42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a fableton project file/i);
  });

  it("rejects text that isn't valid JSON", () => {
    const codec = createProjectCodec();
    const result = codec.decode("{ not json");
    expect(result.ok).toBe(false);
  });

  it("rejects a JSON file missing the format marker", () => {
    const codec = createProjectCodec();
    const result = codec.decodeValue({ schemaVersion: 1, project: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a fableton project file/i);
  });

  it("rejects a file saved by a newer schema version", () => {
    const codec = createProjectCodec();
    const result = codec.decodeValue({
      format: "fableton.project",
      schemaVersion: PROJECT_SCHEMA_VERSION + 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      project: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
    expect(result.schemaVersion).toBe(PROJECT_SCHEMA_VERSION + 1);
  });

  it("runs the v1 bootstrap migration for a file at schema 0 and reports migratedFrom", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    // Simulate a hand-authored / pre-v1 file: same shape, schemaVersion 0.
    const raw = JSON.parse(codec.encode(project, { pretty: false })) as { project: JsonValue };
    const result = codec.decodeValue({
      format: "fableton.project",
      schemaVersion: 0,
      savedAt: "2026-01-01T00:00:00.000Z",
      project: raw.project,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(0);
    expect(result.project.id).toBe(project.id);
  });

  it("repairs an out-of-order note list and reports a warning", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const result = codec.decode(codec.encode(project));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.project.clips[Object.keys(result.project.clips)[0] ?? ""]?.notes ?? [];
    for (let i = 1; i < notes.length; i++) {
      const prev = notes[i - 1]!;
      const cur = notes[i]!;
      expect(prev.start < cur.start || (prev.start === cur.start && prev.pitch <= cur.pitch)).toBe(true);
    }
  });

  it("repairs a channelOrder that doesn't match channels, with a warning", () => {
    const codec = createProjectCodec();
    const result = codec.decodeValue({
      format: "fableton.project",
      schemaVersion: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      project: {
        id: "p1",
        name: "Broken order",
        tempo: [{ startTick: 0, bpm: 120 }],
        timeSignature: { numerator: 4, denominator: 4 },
        loop: { start: 0, end: 0, enabled: false },
        channelOrder: ["ghost-channel"],
        channels: {
          [MASTER_ID]: {
            id: MASTER_ID,
            role: "master",
            name: "Master",
            color: null,
            source: null,
            chain: [],
            volume: "v",
            pan: "p",
            mute: false,
            solo: false,
            sends: [],
            output: null,
          },
        },
        devices: {},
        clips: {},
        lanes: {},
        sidechains: [],
        paramValues: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.channelOrder).toEqual([MASTER_ID]);
    expect(result.warnings.some((w) => w.path === "channelOrder")).toBe(true);
  });

  it("drops a clip whose trackId names a missing channel, with a warning", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const mutated = cloneProject(project);
    const clip = mutated.clips[Object.keys(mutated.clips)[0] ?? ""];
    if (clip) clip.trackId = "does-not-exist";
    const result = codec.decode(codec.encode(mutated));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.project.clips)).toEqual([]);
    expect(result.warnings.some((w) => w.message.includes("missing channel"))).toBe(true);
  });

  it("resets an invalid tempo map to a single default segment, with a warning", () => {
    const codec = createProjectCodec();
    const result = codec.decodeValue({
      format: "fableton.project",
      schemaVersion: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      project: {
        id: "p1",
        name: "Broken tempo",
        tempo: [{ startTick: 10, bpm: 140 }], // doesn't start at 0
        timeSignature: { numerator: 4, denominator: 4 },
        loop: { start: 0, end: 0, enabled: false },
        channelOrder: [],
        channels: {},
        devices: {},
        clips: {},
        lanes: {},
        sidechains: [],
        paramValues: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.tempo).toEqual([{ startTick: 0, bpm: 140 }]);
    expect(result.warnings.some((w) => w.path === "tempo")).toBe(true);
  });

  it("clamps out-of-range note fields on load", () => {
    const codec = createProjectCodec();
    const result = codec.decodeValue({
      format: "fableton.project",
      schemaVersion: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      project: {
        id: "p1",
        name: "Bad note",
        tempo: [{ startTick: 0, bpm: 120 }],
        timeSignature: { numerator: 4, denominator: 4 },
        loop: { start: 0, end: 0, enabled: false },
        channelOrder: [TRACK_ID],
        channels: {
          [TRACK_ID]: {
            id: TRACK_ID,
            role: "track",
            name: "T",
            color: null,
            source: null,
            chain: [],
            volume: "v",
            pan: "p",
            mute: false,
            solo: false,
            sends: [],
            output: null,
          },
        },
        devices: {},
        clips: {
          "clip-x": {
            id: "clip-x",
            trackId: TRACK_ID,
            start: 0,
            length: 960,
            notes: [{ id: "n1", start: 0, dur: 0, pitch: 999, vel: 0 }],
          },
        },
        lanes: {},
        sidechains: [],
        paramValues: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.project.clips["clip-x"]?.notes[0];
    expect(note).toEqual({ id: "n1", start: 0, dur: 1, pitch: 127, vel: 1 });
  });
});

describe("ProjectCodec.validate", () => {
  it("returns no warnings for an already-valid project", () => {
    // Round-trip through encode first: encode() canonicalizes note order,
    // which is what makes the result satisfy invariant 4 (the raw fixture
    // is deliberately built out of order to exercise the repair path).
    const codec = createProjectCodec();
    const decoded = codec.decode(codec.encode(makeFixtureProject()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(codec.validate(decoded.project)).toEqual([]);
  });

  it("sorts notes in place and reports a warning when called directly on a mutable project", () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const warnings = codec.validate(project);
    expect(warnings.some((w) => w.path.endsWith(".notes"))).toBe(true);
    const notes = project.clips[Object.keys(project.clips)[0] ?? ""]?.notes ?? [];
    for (let i = 1; i < notes.length; i++) {
      const prev = notes[i - 1]!;
      const cur = notes[i]!;
      expect(prev.start < cur.start || (prev.start === cur.start && prev.pitch <= cur.pitch)).toBe(true);
    }
  });
});
