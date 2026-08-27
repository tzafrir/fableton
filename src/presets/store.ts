// SS4/SS18-M4 — presets: "bags of parameter values", keyed by DEVICE-LOCAL
// param id so a preset applies to any instance of its definition (and
// survives instance ids changing across a swap, SS7).
//
// Two sources merge in the picker: FACTORY presets shipped as data here,
// and USER presets persisted in `localStorage` (small, per-browser, outside
// the project file — a preset is a library asset, not document state; the
// content-addressed OPFS store the plan sketches arrives with samples).
// Storage failures degrade to in-memory, never to a crash.

import type { DeviceDefinitionId } from "../types";

export interface DevicePreset {
  name: string;
  /** Device-local param id -> real-unit value (SS4). */
  values: Record<string, number>;
  /** Factory presets cannot be deleted from the UI. */
  factory?: boolean;
}

const STORAGE_KEY = "fableton.presets.v1";

type PresetsByDefinition = Record<DeviceDefinitionId, DevicePreset[]>;

export const FACTORY_PRESETS: PresetsByDefinition = {
  "core.poly-synth": [
    { name: "Soft Keys", factory: true, values: { shape: 0, cutoff: 3200, attack: 12, decay: 400, sustain: 55, release: 500, gain: -6 } },
    { name: "Acid Line", factory: true, values: { shape: 2, cutoff: 900, attack: 1, decay: 180, sustain: 0, release: 80, gain: -4 } },
  ],
  "core.pluck": [
    { name: "Nylon", factory: true, values: { shape: 0, decay: 450, brightness: 3800, gain: -3 } },
    { name: "Glass", factory: true, values: { shape: 1, decay: 900, brightness: 9000, gain: -6 } },
  ],
  "core.compressor": [
    { name: "Gentle Glue", factory: true, values: { threshold: -18, ratio: 2, attack: 20, release: 250, makeup: 2 } },
    { name: "SC Pump", factory: true, values: { threshold: -30, ratio: 8, attack: 1, release: 180, makeup: 3 } },
  ],
  "core.reverb": [
    { name: "Room", factory: true, values: { size: 0.8, mix: 18 } },
    { name: "Cathedral", factory: true, values: { size: 6, mix: 38 } },
  ],
  "core.stereo-delay": [
    { name: "Slapback", factory: true, values: { timeL: 90, timeR: 110, feedback: 12, mix: 22 } },
    { name: "Dub Eighths", factory: true, values: { timeL: 250, timeR: 375, feedback: 55, mix: 35 } },
  ],
};

export interface PresetStore {
  /** Factory presets first, then the user's, name-deduplicated (user wins). */
  list(definitionId: DeviceDefinitionId): DevicePreset[];
  save(definitionId: DeviceDefinitionId, name: string, values: Record<string, number>): void;
  remove(definitionId: DeviceDefinitionId, name: string): void;
}

interface Backend {
  read(): PresetsByDefinition;
  write(data: PresetsByDefinition): void;
}

function localStorageBackend(): Backend | null {
  try {
    const probe = "__fbl_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
  } catch {
    return null;
  }
  return {
    read(): PresetsByDefinition {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return {};
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null ? (parsed as PresetsByDefinition) : {};
      } catch {
        return {};
      }
    },
    write(data: PresetsByDefinition): void {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch {
        // Quota/full: the preset stays for this session (memory) only.
      }
    },
  };
}

export function createPresetStore(backend?: Backend | null): PresetStore {
  const persistent = backend === undefined ? localStorageBackend() : backend;
  let memory: PresetsByDefinition = persistent?.read() ?? {};

  const persist = (): void => {
    persistent?.write(memory);
  };

  return {
    list(definitionId: DeviceDefinitionId): DevicePreset[] {
      const user = memory[definitionId] ?? [];
      const factory = FACTORY_PRESETS[definitionId] ?? [];
      const userNames = new Set(user.map((preset) => preset.name));
      return [...factory.filter((preset) => !userNames.has(preset.name)), ...user];
    },

    save(definitionId: DeviceDefinitionId, name: string, values: Record<string, number>): void {
      const trimmed = name.trim();
      if (trimmed.length === 0) return;
      const list = (memory[definitionId] ?? []).filter((preset) => preset.name !== trimmed);
      list.push({ name: trimmed, values: { ...values } });
      memory = { ...memory, [definitionId]: list };
      persist();
    },

    remove(definitionId: DeviceDefinitionId, name: string): void {
      const list = memory[definitionId];
      if (list === undefined) return;
      memory = { ...memory, [definitionId]: list.filter((preset) => preset.name !== name) };
      persist();
    },
  };
}

/** The app-wide store (module singleton, like `projectCommands`). */
export const presetStore: PresetStore = createPresetStore();
