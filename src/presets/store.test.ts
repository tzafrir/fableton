// SS18-M4 presets: factory + user merge, persistence, and validity of the
// shipped factory data against the real device descriptors.

import { describe, expect, it } from "vitest";
import { CORE_DEVICES } from "../devices/core";
import { FACTORY_PRESETS, createPresetStore } from "./store";

function memoryBackend() {
  let data: Record<string, never> | object = {};
  return {
    read: () => data as never,
    write: (next: object) => {
      data = JSON.parse(JSON.stringify(next)) as object;
    },
  };
}

describe("preset store", () => {
  it("lists factory presets for a definition", () => {
    const store = createPresetStore(null);
    const presets = store.list("core.reverb");
    expect(presets.map((p) => p.name)).toEqual(["Room", "Cathedral"]);
    expect(presets.every((p) => p.factory === true)).toBe(true);
  });

  it("saves, overwrites and removes user presets; user shadows factory by name", () => {
    const store = createPresetStore(memoryBackend());
    store.save("core.reverb", "Mine", { size: 2, mix: 50 });
    expect(store.list("core.reverb").map((p) => p.name)).toEqual(["Room", "Cathedral", "Mine"]);

    store.save("core.reverb", "Room", { size: 1, mix: 10 }); // shadows factory
    const room = store.list("core.reverb").filter((p) => p.name === "Room");
    expect(room.length).toBe(1);
    expect(room[0]?.factory).toBeUndefined();

    store.remove("core.reverb", "Mine");
    expect(store.list("core.reverb").some((p) => p.name === "Mine")).toBe(false);
  });

  it("persists through its backend", () => {
    const backend = memoryBackend();
    const a = createPresetStore(backend);
    a.save("core.pluck", "Saved", { decay: 100 });
    const b = createPresetStore(backend);
    expect(b.list("core.pluck").some((p) => p.name === "Saved")).toBe(true);
  });

  it("every factory preset names real params within their ranges", () => {
    for (const [definitionId, presets] of Object.entries(FACTORY_PRESETS)) {
      const def = CORE_DEVICES.find((d) => d.id === definitionId);
      expect(def, `factory presets for unknown device ${definitionId}`).toBeDefined();
      for (const preset of presets) {
        for (const [localId, value] of Object.entries(preset.values)) {
          const desc = def?.params.find((p) => p.id === localId);
          expect(desc, `${definitionId} preset "${preset.name}" names unknown param ${localId}`).toBeDefined();
          expect(value).toBeGreaterThanOrEqual(desc?.min ?? Number.NEGATIVE_INFINITY);
          expect(value).toBeLessThanOrEqual(desc?.max ?? Number.POSITIVE_INFINITY);
        }
      }
    }
  });
});
