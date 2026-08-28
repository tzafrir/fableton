import { describe, expect, it } from "vitest";
import { PPQ } from "../types";
import { panParamId, volumeParamId } from "../params";
import {
  DEFAULT_BPM,
  DEFAULT_INSTRUMENT_DEFINITION_ID,
  DEFAULT_PAN,
  DEFAULT_VOLUME_DB,
  ONE_BAR_TICKS,
  barTicks,
  createEmptyProject,
  findMasterChannelId,
} from "./project";
import { TRACK_COLORS } from "../ui/theme";
import { createSequentialIdFactory } from "./ids";
import { expectLegalProject } from "./testing/invariants";

describe("createEmptyProject", () => {
  it("is the document SS18-M1 describes: master + one instrument track + one empty bar", () => {
    const project = createEmptyProject({ ids: createSequentialIdFactory() });
    expect(project).toEqual({
      id: "prj-1",
      name: "Untitled",
      tempo: [{ startTick: 0, bpm: DEFAULT_BPM }],
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { start: 0, end: ONE_BAR_TICKS, enabled: false },
      channelOrder: ["chan-2", "chan-1"],
      channels: {
        "chan-1": {
          id: "chan-1",
          role: "master",
          name: "Master",
          color: null,
          source: null,
          chain: [],
          volume: volumeParamId("chan-1"),
          pan: panParamId("chan-1"),
          mute: false,
          solo: false,
          sends: [],
          output: null,
        },
        "chan-2": {
          id: "chan-2",
          role: "track",
          name: "Track 1",
          // The starter track takes the first hue off the design system's
          // ribbon — see `createEmptyProject`.
          color: TRACK_COLORS[0],
          source: { kind: "instrument", deviceId: "dev-1" },
          chain: [],
          volume: volumeParamId("chan-2"),
          pan: panParamId("chan-2"),
          mute: false,
          solo: false,
          sends: [],
          output: "chan-1",
        },
      },
      devices: {
        "dev-1": {
          id: "dev-1",
          definitionId: DEFAULT_INSTRUMENT_DEFINITION_ID,
          version: 1,
          channelId: "chan-2",
          enabled: true,
        },
      },
      clips: { "clip-1": { id: "clip-1", trackId: "chan-2", start: 0, length: ONE_BAR_TICKS, notes: [] } },
      lanes: {},
      racks: {},
      sidechains: [],
      assets: {},
      paramValues: {
        [volumeParamId("chan-1")]: DEFAULT_VOLUME_DB,
        [panParamId("chan-1")]: DEFAULT_PAN,
        [volumeParamId("chan-2")]: DEFAULT_VOLUME_DB,
        [panParamId("chan-2")]: DEFAULT_PAN,
      },
    });
  });

  it("satisfies every document invariant", () => {
    expectLegalProject(createEmptyProject({ ids: createSequentialIdFactory() }));
  });

  it("survives a JSON round trip unchanged (SS13: plain serializable data)", () => {
    const project = createEmptyProject({ ids: createSequentialIdFactory() });
    expect(JSON.parse(JSON.stringify(project))).toEqual(project);
  });

  it("is deterministic given a deterministic id factory, and unique otherwise", () => {
    const a = createEmptyProject({ ids: createSequentialIdFactory() });
    const b = createEmptyProject({ ids: createSequentialIdFactory() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(createEmptyProject().id).not.toBe(createEmptyProject().id);
  });

  it("takes a name and a pinned project id", () => {
    const project = createEmptyProject({ name: "Demo", id: "fixed", ids: createSequentialIdFactory() });
    expect(project.id).toBe("fixed");
    expect(project.name).toBe("Demo");
  });

  it("finds the master channel by role, not by position", () => {
    const project = createEmptyProject({ ids: createSequentialIdFactory() });
    project.channelOrder.reverse();
    expect(findMasterChannelId(project)).toBe("chan-1");
  });
});

describe("barTicks", () => {
  it("is PPQ*4 in 4/4 and shorter in 6/8", () => {
    expect(barTicks({ numerator: 4, denominator: 4 })).toBe(PPQ * 4);
    expect(barTicks({ numerator: 6, denominator: 8 })).toBe(PPQ * 3);
    expect(barTicks({ numerator: 3, denominator: 4 })).toBe(PPQ * 3);
  });
});
