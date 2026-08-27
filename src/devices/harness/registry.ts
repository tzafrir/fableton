// SS7 — "A device is a DEFINITION — pure data plus factory — registered by
// id." This is that registry: the browser panel's two lists (`listByKind`),
// the project loader's `require(id)`, and the one place a malformed
// definition is caught, at registration, instead of at `create` time.
//
// SS7 "Versioning": `version` is part of the definition's identity. Saved
// projects record the version they were written with, and `migrateParams`
// maps old values forward — so registering two different definitions under
// one id would silently break that contract and is refused here.

import type {
  DeviceDefinition,
  DeviceDefinitionId,
  DeviceKind,
  DeviceRegistry,
  PortSpec,
} from "../../types";
import { PARAM_PATH_SEPARATOR } from "../../params/paramIds";

const KINDS: readonly DeviceKind[] = ["instrument", "audioEffect"];

/** `DeviceRegistry` plus the removal verbs tests and hot-reload need. */
export interface AppDeviceRegistry extends DeviceRegistry {
  registerAll(defs: Iterable<DeviceDefinition>): void;
  /** Removes a definition. Already-mounted instances are unaffected. */
  unregister(id: DeviceDefinitionId): void;
  clear(): void;
}

function assertPorts(def: DeviceDefinition, ports: readonly PortSpec[], where: string): void {
  if (!Array.isArray(ports)) {
    throw new Error(`DeviceDefinition "${def.id}": ${where} must be an array of PortSpec`);
  }
  const seen = new Set<string>();
  for (const port of ports) {
    if (typeof port.id !== "string" || port.id.length === 0) {
      throw new Error(`DeviceDefinition "${def.id}": ${where} has a port with an empty id`);
    }
    if (seen.has(port.id)) {
      throw new Error(`DeviceDefinition "${def.id}": ${where} declares port "${port.id}" twice`);
    }
    seen.add(port.id);
    if (port.channels !== undefined && (!Number.isInteger(port.channels) || port.channels < 1)) {
      throw new Error(
        `DeviceDefinition "${def.id}": port "${port.id}" has a non-positive channel count`,
      );
    }
  }
}

/**
 * Everything that must hold before a definition can be mounted. Cheap checks,
 * run once at registration — a device author sees the mistake at import time
 * rather than as silence in the graph.
 */
export function validateDefinition(def: DeviceDefinition): void {
  if (typeof def?.id !== "string" || def.id.length === 0) {
    throw new Error("DeviceRegistry.register: definition needs a non-empty id");
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`DeviceDefinition "${def.id}": version must be an integer >= 1 (SS7)`);
  }
  if (!KINDS.includes(def.kind)) {
    throw new Error(`DeviceDefinition "${def.id}": kind must be one of ${KINDS.join(" | ")}`);
  }
  if (typeof def.label !== "string" || def.label.length === 0) {
    throw new Error(`DeviceDefinition "${def.id}": label must be a non-empty string`);
  }
  if (typeof def.create !== "function") {
    throw new Error(`DeviceDefinition "${def.id}": create(ctx, io) is required`);
  }
  if (!Array.isArray(def.params)) {
    throw new Error(`DeviceDefinition "${def.id}": params must be an array of ParamDescriptor`);
  }
  const localIds = new Set<string>();
  for (const desc of def.params) {
    const localId = desc?.id;
    if (typeof localId !== "string" || localId.length === 0) {
      throw new Error(`DeviceDefinition "${def.id}": a param descriptor has an empty id`);
    }
    // Local ids become one path segment of `chan:.../dev:.../<localId>` (SS4).
    if (localId.includes(PARAM_PATH_SEPARATOR)) {
      throw new Error(
        `DeviceDefinition "${def.id}": param id "${localId}" must not contain ${JSON.stringify(PARAM_PATH_SEPARATOR)}`,
      );
    }
    if (localIds.has(localId)) {
      throw new Error(`DeviceDefinition "${def.id}": duplicate param id "${localId}"`);
    }
    localIds.add(localId);
  }
  assertPorts(def, def.audioIn, "audioIn");
  assertPorts(def, def.audioOut, "audioOut");
  if (def.audioOut.length === 0) {
    throw new Error(`DeviceDefinition "${def.id}": every device needs at least one audio output`);
  }
  if (def.kind === "audioEffect" && def.audioIn.length === 0) {
    throw new Error(`DeviceDefinition "${def.id}": an audioEffect needs at least one audio input`);
  }
  for (const row of def.panel?.rows ?? []) {
    for (const control of row.controls) {
      if (!localIds.has(control.paramId)) {
        throw new Error(
          `DeviceDefinition "${def.id}": panel references unknown param "${control.paramId}"`,
        );
      }
    }
  }
}

/** The app's device registry. `createDeviceRegistry(coreDevices)` at boot. */
export function createDeviceRegistry(
  initial: Iterable<DeviceDefinition> = [],
): AppDeviceRegistry {
  const defs = new Map<DeviceDefinitionId, DeviceDefinition>();

  const registry: AppDeviceRegistry = {
    register(def: DeviceDefinition): void {
      validateDefinition(def);
      const existing = defs.get(def.id);
      if (existing !== undefined) {
        // Idempotent for module-scope `registry.register(X)` re-entry; a
        // DIFFERENT definition under a live id is a versioning bug (SS7).
        if (existing === def) return;
        throw new Error(
          `DeviceRegistry: "${def.id}" is already registered (v${existing.version}); unregister it first`,
        );
      }
      defs.set(def.id, def);
    },

    registerAll(list: Iterable<DeviceDefinition>): void {
      for (const def of list) registry.register(def);
    },

    unregister(id: DeviceDefinitionId): void {
      defs.delete(id);
    },

    clear(): void {
      defs.clear();
    },

    get(id: DeviceDefinitionId): DeviceDefinition | undefined {
      return defs.get(id);
    },

    require(id: DeviceDefinitionId): DeviceDefinition {
      const def = defs.get(id);
      if (def === undefined) {
        throw new Error(`DeviceRegistry: unknown device "${id}"`);
      }
      return def;
    },

    has(id: DeviceDefinitionId): boolean {
      return defs.has(id);
    },

    list(): readonly DeviceDefinition[] {
      return [...defs.values()];
    },

    listByKind(kind: DeviceKind): readonly DeviceDefinition[] {
      return [...defs.values()].filter((def) => def.kind === kind);
    },
  };

  registry.registerAll(initial);
  return registry;
}
