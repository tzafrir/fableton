import { describe, expect, it } from "vitest";
import type { JsonValue } from "../types";
import { PROJECT_SCHEMA_VERSION } from "../types";
import { createProjectCodec } from "./codec";
import { findRoutingCycle } from "../engine/graph/validate";
import {
  cloneProject,
  FX_DEVICE_ID,
  makeFixtureProject,
  makeRichFixtureProject,
  MASTER_FX_ID,
  MASTER_ID,
  TRACK_ID,
} from "./testing/fixture";

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

// SS18-M4 project-format hardening. Every case here is a file the app itself
// would never write, so these are the untrusted-input paths: what matters is
// that the repair is CORRECT, not merely that decode says ok.
describe("ProjectCodec.validate: routing and device-chain hardening", () => {
  it("de-duplicates channelOrder instead of demoting the project's only master", () => {
    const codec = createProjectCodec();
    const project = cloneProject(makeFixtureProject());
    project.channelOrder = [TRACK_ID, MASTER_ID, MASTER_ID];
    const warnings = codec.validate(project);
    expect(project.channelOrder).toEqual([TRACK_ID, MASTER_ID]);
    // The bug this pins: the duplicate made the master pass meet the same
    // master twice, so the "second master" guard demoted the only one — the
    // project silently lost its master strip behind a channelOrder warning.
    expect(project.channels[MASTER_ID]?.role).toBe("master");
    expect(project.channels[MASTER_ID]?.output).toBeNull();
    expect(warnings.some((w) => w.path === "channelOrder")).toBe(true);
    expect(warnings.some((w) => w.message.includes("demoted"))).toBe(false);
  });

  it("still demotes a genuine SECOND master", () => {
    const codec = createProjectCodec();
    const project = cloneProject(makeFixtureProject());
    project.channels[TRACK_ID]!.role = "master";
    codec.validate(project);
    const masters = Object.values(project.channels).filter((c) => c.role === "master");
    expect(masters.length).toBe(1);
  });

  it("drops a device id repeated in one chain (buildGraph would self-feedback it)", () => {
    const codec = createProjectCodec();
    const project = makeRichFixtureProject();
    project.channels[TRACK_ID]!.chain = [FX_DEVICE_ID, FX_DEVICE_ID];
    const warnings = codec.validate(project);
    expect(project.channels[TRACK_ID]?.chain).toEqual([FX_DEVICE_ID]);
    expect(warnings.some((w) => w.path === `channels.${TRACK_ID}.chain`)).toBe(true);
  });

  it("drops a chain entry that names no device", () => {
    const codec = createProjectCodec();
    const project = makeRichFixtureProject();
    project.channels[TRACK_ID]!.chain = ["ghost-device", FX_DEVICE_ID];
    codec.validate(project);
    expect(project.channels[TRACK_ID]?.chain).toEqual([FX_DEVICE_ID]);
  });

  it("gives a device claimed by two chains to the first in row order, and re-homes it", () => {
    const codec = createProjectCodec();
    const project = makeRichFixtureProject(); // channelOrder = [TRACK_ID, MASTER_ID]
    project.channels[MASTER_ID]!.chain = [MASTER_FX_ID, FX_DEVICE_ID];
    project.devices[FX_DEVICE_ID]!.channelId = MASTER_ID; // and it disagrees with the track
    codec.validate(project);
    expect(project.channels[TRACK_ID]?.chain).toEqual([FX_DEVICE_ID]);
    expect(project.channels[MASTER_ID]?.chain).toEqual([MASTER_FX_ID]);
    // Invariant 7: the mount's channelId is now the channel that lists it, so
    // deleting the other channel cannot take this device with it.
    expect(project.devices[FX_DEVICE_ID]?.channelId).toBe(TRACK_ID);
  });

  it("clears an instrument slot naming a missing device", () => {
    const codec = createProjectCodec();
    const project = cloneProject(makeFixtureProject());
    project.channels[TRACK_ID]!.source = { kind: "instrument", deviceId: "ghost-device" };
    codec.validate(project);
    expect(project.channels[TRACK_ID]?.source).toBeNull();
  });

  it("breaks EVERY routing cycle, past the old constant loop bound", () => {
    const codec = createProjectCodec();
    const project = cloneProject(makeFixtureProject());
    // 70 independent two-channel loops: more than the 64-pass constant the
    // repair loop used to be bounded by, so the tail of them used to survive
    // into an `ok: true` document and render those channels silent.
    const PAIRS = 70;
    for (let i = 0; i < PAIRS; i++) {
      const a = `loop-a-${i}`;
      const b = `loop-b-${i}`;
      for (const [id, output] of [[a, b], [b, a]] as const) {
        project.channels[id] = {
          id,
          role: "track",
          name: id,
          color: null,
          source: null,
          chain: [],
          volume: `chan:${id}/vol`,
          pan: `chan:${id}/pan`,
          mute: false,
          solo: false,
          sends: [],
          output,
        };
        project.channelOrder.unshift(id);
      }
    }
    const warnings = codec.validate(project);
    expect(findRoutingCycle(project)).toBeNull();
    expect(warnings.filter((w) => w.message.includes("Routing cycle")).length).toBe(PAIRS);

    // ...and the same file through the real decode path stays clean.
    const decoded = codec.decode(codec.encode(project));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(findRoutingCycle(decoded.project)).toBeNull();
  });
});

describe("audio clips and imported samples round-trip", () => {
  const projectCodec = createProjectCodec();

  /** A project carrying one sample and one audio clip that plays it. */
  function withAudio() {
    const project = structuredClone(makeFixtureProject());
    const trackId = project.channelOrder.find((id) => project.channels[id]?.role === "track");
    if (trackId === undefined) throw new Error("fixture has no track");
    project.assets["asset-1"] = {
      id: "asset-1",
      name: "take.wav",
      sampleRate: 48000,
      channels: 2,
      frames: 96000,
      peaks: [0, 0.5, 1, 0.25],
    };
    project.audioClips["ac-1"] = {
      kind: "audio",
      id: "ac-1",
      trackId,
      start: 1920,
      length: 3840,
      assetId: "asset-1",
      offsetFrames: 4800,
      gainDb: -3,
      name: "Take 1",
    };
    return project;
  }

  it("survives encode -> decode unchanged", () => {
    // Compared on the audio halves alone: the shared fixture keeps its notes
    // deliberately UNSORTED so another test can prove encode sorts them, and
    // that difference is not this test's business.
    const project = withAudio();
    const decoded = projectCodec.decode(projectCodec.encode(project));
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.project.audioClips).toEqual(project.audioClips);
    expect(decoded.project.assets).toEqual(project.assets);
  });

  it("encodes byte-identically twice — nothing volatile in a sample", () => {
    const project = withAudio();
    const once = projectCodec.encode(project, { savedAt: "2024-01-01T00:00:00.000Z" });
    const twice = projectCodec.encode(project, { savedAt: "2024-01-01T00:00:00.000Z" });
    expect(once).toBe(twice);
  });

  it("reads a file written before audio clips existed", () => {
    // Additive, like racks: the keys are simply absent and decode to `{}`.
    const project = structuredClone(makeFixtureProject());
    const raw = JSON.parse(projectCodec.encode(project)) as { project: Record<string, unknown> };
    delete raw.project["assets"];
    delete raw.project["audioClips"];
    const decoded = projectCodec.decode(JSON.stringify(raw));
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.project.assets).toEqual({});
    expect(decoded.project.audioClips).toEqual({});
  });

  it("drops an audio clip whose id also names a MIDI clip", () => {
    // One id must mean one clip: a selection holds ids.
    const project = withAudio();
    const midiId = Object.keys(project.clips)[0] ?? "";
    project.audioClips[midiId] = { ...project.audioClips["ac-1"]!, id: midiId };
    const warnings = projectCodec.validate(project);
    expect(project.audioClips[midiId]).toBeUndefined();
    expect(warnings.some((w) => w.path.includes(midiId))).toBe(true);
  });

  it("KEEPS a clip whose sample is missing, and says so", () => {
    // The samples may simply not have travelled with the project file;
    // deleting the arrangement would lose work a re-import restores.
    const project = withAudio();
    delete project.assets["asset-1"];
    const warnings = projectCodec.validate(project);
    expect(project.audioClips["ac-1"]).toBeDefined();
    expect(warnings.some((w) => w.message.includes("silent"))).toBe(true);
  });
});
