import { beforeEach, describe, expect, it } from "vitest";
import type { DeviceDefinition, DeviceRegistry } from "../../types";
import { deviceInstance } from "./deviceInstance";
import { p } from "./params";
import { createDeviceRegistry, validateDefinition, type AppDeviceRegistry } from "./registry";

function def(overrides: Partial<DeviceDefinition> = {}): DeviceDefinition {
  return {
    id: "core.stereo-delay",
    version: 1,
    kind: "audioEffect",
    label: "Stereo Delay",
    params: [p.time("timeL", "Time L", { min: 1, max: 2000, default: 250 })],
    audioIn: [{ id: "in" }],
    audioOut: [{ id: "out" }],
    create: () => deviceInstance({ dispose: () => {} }),
    ...overrides,
  };
}

let registry: AppDeviceRegistry;

beforeEach(() => {
  registry = createDeviceRegistry();
});

describe("DeviceRegistry lookup (SS7/SS14 `registry.register(StereoDelay)`)", () => {
  it("registers and looks definitions up by id", () => {
    const delay = def();
    registry.register(delay);
    expect(registry.has("core.stereo-delay")).toBe(true);
    expect(registry.get("core.stereo-delay")).toBe(delay);
    expect(registry.require("core.stereo-delay")).toBe(delay);
    expect(registry.list()).toEqual([delay]);
    expect(registry.get("core.nope")).toBeUndefined();
    expect(() => registry.require("core.nope")).toThrow(/unknown device/);
  });

  it("splits the browser panel's two lists by kind", () => {
    const synth = def({ id: "core.poly-synth", kind: "instrument", audioIn: [] });
    registry.registerAll([def(), synth]);
    expect(registry.listByKind("instrument")).toEqual([synth]);
    expect(registry.listByKind("audioEffect").map((d) => d.id)).toEqual(["core.stereo-delay"]);
  });

  it("keeps the version on the definition and refuses a second one under the id", () => {
    const v1 = def();
    registry.register(v1);
    registry.register(v1); // module re-entry is a no-op
    expect(registry.list()).toHaveLength(1);
    expect(registry.require("core.stereo-delay").version).toBe(1);
    expect(() => registry.register(def({ version: 2 }))).toThrow(/already registered/);

    registry.unregister("core.stereo-delay");
    registry.register(def({ version: 2 }));
    expect(registry.require("core.stereo-delay").version).toBe(2);
    registry.clear();
    expect(registry.list()).toEqual([]);
  });

  it("satisfies the frozen DeviceRegistry contract", () => {
    const asContract: DeviceRegistry = registry;
    asContract.register(def());
    expect(asContract.listByKind("audioEffect")).toHaveLength(1);
  });

  it("takes an initial definition list", () => {
    expect(createDeviceRegistry([def()]).list()).toHaveLength(1);
  });
});

describe("definition validation (caught at registration, not at create)", () => {
  const bad = (overrides: Partial<DeviceDefinition>, message: RegExp) => {
    expect(() => registry.register(def(overrides))).toThrow(message);
  };

  it("requires an id, a label, a create and an integer version >= 1", () => {
    bad({ id: "" }, /non-empty id/);
    bad({ version: 0 }, /version must be an integer/);
    bad({ version: 1.5 }, /version must be an integer/);
    bad({ label: "" }, /label/);
    bad({ create: undefined as unknown as DeviceDefinition["create"] }, /create/);
    bad({ kind: "sfx" as DeviceDefinition["kind"] }, /kind must be one of/);
  });

  it("guards the param local-id contract (SS4 path segments)", () => {
    const timeL = p.time("timeL", "Time L", { min: 1, max: 2000, default: 250 });
    bad({ params: [timeL, timeL] }, /duplicate param id/);
    bad({ params: [{ ...timeL, id: "a/b" }] }, /must not contain/);
    bad({ params: [{ ...timeL, id: "" }] }, /empty id/);
  });

  it("guards ports and panels", () => {
    bad({ audioOut: [] }, /at least one audio output/);
    bad({ audioIn: [] }, /audioEffect needs at least one audio input/);
    bad({ audioIn: [{ id: "in" }, { id: "in" }] }, /declares port "in" twice/);
    bad({ audioIn: [{ id: "in", channels: 0 }] }, /channel count/);
    bad({ panel: { rows: [{ controls: [{ paramId: "nope" }] }] } }, /unknown param "nope"/);
  });

  it("accepts the SS14 stereo-delay shape verbatim", () => {
    expect(() =>
      validateDefinition(
        def({
          audioIn: [{ id: "in" }, { id: "sc", label: "Sidechain", optional: true }],
          params: [
            p.time("timeL", "Time L", { min: 1, max: 2000, default: 250 }),
            p.time("timeR", "Time R", { min: 1, max: 2000, default: 375 }),
            p.pct("feedback", "Feedback", { default: 35, max: 95 }),
            p.pct("mix", "Mix", { default: 25 }),
          ],
          panel: { rows: [{ controls: [{ paramId: "mix", control: "knob" }] }] },
        }),
      ),
    ).not.toThrow();
  });
});
