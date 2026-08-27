import { describe, expect, it } from "vitest";
import {
  deviceParamId,
  isChannelParamId,
  isDeviceParamId,
  localParamId,
  panParamId,
  parseParamId,
  qualifyDescriptor,
  sendParamId,
  volumeParamId,
  withParamId,
} from "./paramIds";
import { p } from "./descriptors";

describe("param id builders (SS4 id scheme)", () => {
  it("builds the exact paths the plan documents", () => {
    expect(deviceParamId("g4", "d12", "cutoff")).toBe("chan:g4/dev:d12/cutoff");
    expect(volumeParamId("g4")).toBe("chan:g4/vol");
    expect(panParamId("g4")).toBe("chan:g4/pan");
    expect(sendParamId("g4", "a")).toBe("chan:g4/send:a");
  });

  it("rejects segments that would break the path grammar", () => {
    expect(() => deviceParamId("g4", "d/12", "cutoff")).toThrow();
    expect(() => deviceParamId("", "d12", "cutoff")).toThrow();
    expect(() => volumeParamId("")).toThrow();
    expect(() => sendParamId("g4", "a/b")).toThrow();
  });
});

describe("parseParamId", () => {
  it("round-trips every shape", () => {
    expect(parseParamId(deviceParamId("g4", "d12", "cutoff"))).toEqual({
      kind: "device",
      channelId: "g4",
      instanceId: "d12",
      localId: "cutoff",
    });
    expect(parseParamId(volumeParamId("t1"))).toEqual({ kind: "volume", channelId: "t1" });
    expect(parseParamId(panParamId("t1"))).toEqual({ kind: "pan", channelId: "t1" });
    expect(parseParamId(sendParamId("t1", "ret-a"))).toEqual({
      kind: "send",
      channelId: "t1",
      targetChannelId: "ret-a",
    });
  });

  it("returns null (never throws) on malformed ids", () => {
    for (const bad of [
      "",
      "cutoff",
      "dev:d12/cutoff",
      "chan:/vol",
      "chan:t1/",
      "chan:t1/nope",
      "chan:t1/dev:/cutoff",
      "chan:t1/dev:d12/",
      "chan:t1/dev:d12/a/b",
      "chan:t1/send:",
    ]) {
      expect(parseParamId(bad)).toBeNull();
    }
  });

  it("answers ownership questions used by disposal and lane menus", () => {
    const id = deviceParamId("t1", "d9", "drive");
    expect(isChannelParamId(id, "t1")).toBe(true);
    expect(isChannelParamId(id, "t2")).toBe(false);
    expect(isDeviceParamId(id, "d9")).toBe(true);
    expect(isDeviceParamId(volumeParamId("t1"), "d9")).toBe(false);
    expect(localParamId(id)).toBe("drive");
    expect(localParamId(volumeParamId("t1"))).toBeNull();
  });
});

describe("descriptor id rewriting (SS7 local ids -> full paths)", () => {
  it("qualifies without mutating the shared definition descriptor", () => {
    const local = p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1200 });
    const full = qualifyDescriptor(local, { channelId: "t1", instanceId: "d3" });
    expect(full.id).toBe("chan:t1/dev:d3/cutoff");
    expect(local.id).toBe("cutoff");
    expect(full.toText(1200)).toBe(local.toText(1200));
  });

  it("withParamId targets mixer paths", () => {
    const desc = p.db("vol", "Volume", { min: -70, max: 6, default: 0 });
    expect(withParamId(desc, volumeParamId("t1")).id).toBe("chan:t1/vol");
  });
});
