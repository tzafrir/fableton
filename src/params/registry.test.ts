import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamRegistry } from "../types";
import { p } from "./descriptors";
import { deviceParamId, isDeviceParamId, panParamId, volumeParamId } from "./paramIds";
import { LIVE_WRITE_LEAD_SECONDS } from "./handle";
import { createParamRegistry, registerWithValue, type AppParamRegistry } from "./registry";

const CUTOFF = deviceParamId("t1", "d1", "cutoff");

let registry: AppParamRegistry;

function cutoff(id = CUTOFF) {
  return { ...p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1000 }), id };
}

beforeEach(() => {
  registry = createParamRegistry({ schedule: () => 0 });
});

describe("ParamRegistry lookup surface (SS4)", () => {
  it("registers, finds and lists handles", () => {
    const handle = registry.register(cutoff());
    expect(registry.has(CUTOFF)).toBe(true);
    expect(registry.get(CUTOFF)).toBe(handle);
    expect(registry.require(CUTOFF)).toBe(handle);
    expect(registry.list()).toEqual([handle]);
    expect(registry.get("chan:nope/vol")).toBeUndefined();
    expect(() => registry.require("chan:nope/vol")).toThrow(/unknown param/);
  });

  it("refuses a duplicate id", () => {
    registry.register(cutoff());
    expect(() => registry.register(cutoff())).toThrow(/already registered/);
  });

  it("satisfies the frozen ParamRegistry contract", () => {
    const asContract: ParamRegistry = registry;
    expect(typeof asContract.register).toBe("function");
    expect(asContract.hasOverrides()).toBe(false);
    expect(() => asContract.reenableAutomation()).not.toThrow();
  });

  it("hands lookups the SS4 surface only, not the registry's own verbs", () => {
    registry.register(cutoff());
    const handle = registry.require(CUTOFF);
    expect(typeof handle.setLive).toBe("function");
    expect(typeof handle.commit).toBe("function");
    // SS3: "there are exactly two ways anything changes at runtime". `setBase`
    // / `setAutomated` / `unbind` write into the DSP (and the document mirror)
    // without a commit, so a registry lookup must not surface them — only the
    // caller that registered the param holds the widened handle.
    // @ts-expect-error — setBase is not on ParamHandle
    expect(typeof handle.setBase).toBe("function");
    // @ts-expect-error — unbind is not on ParamHandle
    expect(typeof handle.unbind).toBe("function");
    // @ts-expect-error — setAutomated is not on ParamHandle
    expect(typeof handle.setAutomated).toBe("function");
  });

  it("rejects structurally broken descriptors at registration", () => {
    expect(() => registry.register({ ...cutoff(), id: "" })).toThrow();
    expect(() => registry.register({ ...cutoff(), min: 100, max: 10 })).toThrow(/max/);
    expect(() => registry.register({ ...cutoff(), min: Number.NaN })).toThrow(/finite/);
    expect(() =>
      registry.register({ ...cutoff(), defaultValue: Number.POSITIVE_INFINITY }),
    ).toThrow(/defaultValue/);
    expect(() => registry.register({ ...cutoff(), min: 0, taper: "log" })).toThrow(/log/);
  });

  it("copies the descriptor so shared device definitions are never mutated", () => {
    const desc = cutoff();
    const handle = registry.register(desc);
    expect(handle.desc).not.toBe(desc);
    expect(handle.desc.id).toBe(CUTOFF);
  });

  it("clamps a default that sits outside the range", () => {
    const handle = registry.register({ ...cutoff(), defaultValue: 999999 });
    expect(handle.base()).toBe(20000);
  });
});

describe("registry lifecycle", () => {
  it("notifies on register/unregister, not on value changes", () => {
    const cb = vi.fn();
    registry.onRegistryChange(cb);
    const handle = registry.register(cutoff());
    expect(cb).toHaveBeenCalledTimes(1);

    handle.setLive(1234, "user");
    handle.commit();
    expect(cb).toHaveBeenCalledTimes(1);

    registry.unregister(CUTOFF);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(registry.has(CUTOFF)).toBe(false);

    registry.unregister(CUTOFF); // safe on unknown ids
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("unregistering an overridden param clears the transport pill", () => {
    const handle = registry.register(cutoff());
    handle.setAutomated(true);
    handle.setLive(500, "user");
    expect(registry.hasOverrides()).toBe(true);
    registry.unregister(CUTOFF);
    expect(registry.hasOverrides()).toBe(false);
  });

  it("unregisterWhere drops a whole device's params", () => {
    registry.register(cutoff());
    registry.register({ ...cutoff(deviceParamId("t1", "d1", "res")), label: "Resonance" });
    registry.register({
      ...p.db("vol", "Volume", { min: -70, max: 6, default: 0 }),
      id: volumeParamId("t1"),
    });

    registry.unregisterWhere((id) => isDeviceParamId(id, "d1"));
    expect(registry.list().map((h) => h.desc.id)).toEqual([volumeParamId("t1")]);
  });

  it("dispose clears everything and stops further pushes", () => {
    const handle = registry.register(cutoff());
    const messages: number[] = [];
    handle.bindMessage((v) => messages.push(v));
    registry.dispose();
    expect(registry.list()).toEqual([]);
    handle.setLive(3000, "user");
    expect(messages).toEqual([1000]);
  });
});

describe("document <-> registry sync (SS3 document path)", () => {
  it("load clamps to the descriptor range and reports unknown ids", () => {
    const handle = registry.register(cutoff());
    registry.register({
      ...p.pan("pan", "Pan"),
      id: panParamId("t1"),
    });

    const unknown = registry.load({
      [CUTOFF]: 1e9,
      [panParamId("t1")]: -0.25,
      "chan:gone/dev:x/y": 3,
    });

    expect(handle.base()).toBe(20000);
    expect(handle.live()).toBe(20000); // free params follow the document
    expect(registry.require(panParamId("t1")).base()).toBeCloseTo(-0.25, 9);
    expect(unknown).toEqual(["chan:gone/dev:x/y"]);
  });

  it("load pushes through to the live binding while a param is free", () => {
    const handle = registry.register(cutoff());
    const messages: number[] = [];
    handle.bindMessage((v) => messages.push(v));
    registry.load({ [CUTOFF]: 600 });
    expect(messages).toEqual([1000, 600]);
  });

  it("load does not fight automation on an automated param", () => {
    const handle = registry.register(cutoff());
    handle.setAutomated(true);
    handle.setLive(300, "automation");
    registry.load({ [CUTOFF]: 5000 });
    expect(handle.base()).toBe(5000);
    expect(handle.live()).toBe(300);
  });

  it("snapshot returns committed values only (presets, save)", () => {
    const handle = registry.register(cutoff());
    handle.setLive(4000, "user");
    expect(registry.snapshot()).toEqual({ [CUTOFF]: 1000 });
    handle.commit();
    expect(registry.snapshot()).toEqual({ [CUTOFF]: 4000 });
  });

  it("registerWithValue seeds a param from a saved document value", () => {
    const handle = registerWithValue(registry, cutoff(), 250);
    expect(handle.base()).toBe(250);
    expect(handle.live()).toBe(250);
  });
});

describe("audio clock", () => {
  it("can be attached after the context is unlocked", () => {
    const handle = registry.register(cutoff());
    const times: number[] = [];
    handle.bindMessage((_v, when) => times.push(when));
    expect(registry.now()).toBe(0);

    let currentTime = 12.5;
    registry.setClock(() => currentTime);
    handle.setLive(900, "user");
    currentTime = 13;
    handle.setLive(910, "user");
    // The two later writes are hand-driven and carry the live-write lead.
    expect(times).toEqual([0, 12.5 + LIVE_WRITE_LEAD_SECONDS, 13 + LIVE_WRITE_LEAD_SECONDS]);
  });
});
