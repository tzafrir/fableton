// SS3/SS4/SS13 — the param fast path's one document write.
//
// A knob drag must NOT dirty the document while it moves and must produce
// exactly one undo entry at release; undo must be audible, which means the
// value has to travel back into the registry.

import { describe, expect, it, vi } from "vitest";
import type { ParamId, Project } from "../types";
import { createParamRegistry, deviceParamId, p, volumeParamId, type AppParamRegistry } from "../params";
import { connectParamRegistry, applyParamValues } from "./paramBridge";
import { makeFixture } from "./testing/fixture";

/** Frames run inline: `onChange` coalescing is not what these tests are about. */
function makeRegistry(): AppParamRegistry {
  return createParamRegistry({ schedule: (cb) => cb() });
}

function setup() {
  const fixture = makeFixture();
  const registry = makeRegistry();
  // Params register under their FULL SS4 path — that is the id the document
  // stores and the id the bridge speaks.
  const cutoffId: ParamId = deviceParamId(fixture.trackId, fixture.deviceId, "cutoff");
  const cutoffHandle = registry.register(
    p.hz(cutoffId, "Cutoff", { min: 20, max: 20000, defaultValue: 1000 }),
  );
  const volume = registry.register(
    p.db(volumeParamId(fixture.trackId), "Volume", { min: -60, max: 6, defaultValue: 0 }),
  );
  const unsub = connectParamRegistry(fixture.store, registry);
  return { ...fixture, registry, cutoffId, cutoffHandle, volume, unsub };
}

describe("connectParamRegistry", () => {
  it("does not touch the document while a gesture is moving", () => {
    const { store, cutoffHandle } = setup();
    const before = store.getState();
    for (const value of [400, 500, 600]) cutoffHandle.setLive(value, "user");
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it("turns one commit into exactly one setParamValue command", () => {
    const { store, cutoffHandle, cutoffId } = setup();
    for (const value of [400, 500, 600]) cutoffHandle.setLive(value, "user");
    cutoffHandle.commit();

    expect(store.getState().paramValues[cutoffId]).toBe(600);
    expect(store.history()).toHaveLength(1);
    expect(store.undoLabel()).toBe("Set Parameter");
  });

  it("writes an undone value back into the registry (undo is audible)", () => {
    const { store, cutoffHandle, cutoffId } = setup();
    cutoffHandle.setLive(5000, "user");
    cutoffHandle.commit();
    expect(cutoffHandle.base()).toBe(5000);

    store.undo();
    // The param had no document value before, so undo REMOVES the key and the
    // param returns to its descriptor default.
    expect(store.getState().paramValues[cutoffId]).toBeUndefined();
    expect(cutoffHandle.base()).toBe(1000);
    expect(cutoffHandle.live()).toBe(1000);

    store.redo();
    expect(cutoffHandle.base()).toBe(5000);
  });

  it("restores a previous document value on undo, not the default", () => {
    const { store, volume, trackId } = setup();
    const volumeId = volumeParamId(trackId);
    volume.setLive(-6, "user");
    volume.commit();
    volume.setLive(-12, "user");
    volume.commit();
    expect(store.history()).toHaveLength(2);

    store.undo();
    expect(volume.base()).toBe(-6);
    store.undo();
    expect(volume.base()).toBe(0);
    expect(store.getState().paramValues[volumeId]).toBe(0);
  });

  it("does not echo its own command back into the registry", () => {
    const { store, registry, cutoffHandle } = setup();
    const load = vi.spyOn(registry, "load");
    cutoffHandle.setLive(800, "user");
    cutoffHandle.commit();
    expect(load).not.toHaveBeenCalled();
    void store;
  });

  it("loads every registered param after a document replace", () => {
    const { store, registry, cutoffHandle, volume, trackId, cutoffId } = setup();
    const replacement = structuredClone(store.getState()) as Project;
    replacement.paramValues[cutoffId] = 7000;
    delete replacement.paramValues[volumeParamId(trackId)];
    volume.setLive(-20, "user");
    volume.commit();

    store.replaceDocument(replacement);

    expect(cutoffHandle.base()).toBe(7000);
    // Absent from the loaded document -> back to the descriptor default.
    expect(volume.base()).toBe(0);
    void registry;
  });

  it("reports document params no live handle claims (device not mounted yet)", () => {
    const seen: ParamId[][] = [];
    const fixture = makeFixture();
    const registry = makeRegistry();
    connectParamRegistry(fixture.store, registry, { onUnknownParams: (ids) => seen.push([...ids]) });

    const replacement = structuredClone(fixture.store.getState()) as Project;
    replacement.paramValues["chan:ghost/dev:ghost/cutoff"] = 900;
    fixture.store.replaceDocument(replacement);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("chan:ghost/dev:ghost/cutoff");
  });

  it("stops listening after the returned unsubscribe", () => {
    const { store, cutoffHandle, unsub } = setup();
    unsub();
    cutoffHandle.setLive(1234, "user");
    cutoffHandle.commit();
    expect(store.canUndo()).toBe(false);
  });

  it("applyParamValues pushes a document bag into the registry", () => {
    const { registry, cutoffId, cutoffHandle } = setup();
    const unknown = applyParamValues(registry, { [cutoffId]: 250, "chan:ghost/vol": -3 });
    expect(cutoffHandle.base()).toBe(250);
    expect(unknown).toEqual(["chan:ghost/vol"]);
  });
});
