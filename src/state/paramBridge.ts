// SS3/SS4 — the param fast path's one document write, and its way back.
//
// "Continuous gestures stay on the param fast path and contribute exactly one
// command at release" (SS13). A knob drag writes through
// `ParamHandle.setLive` at gesture rate — the document never sees it — and
// emits one `ParamCommit` on release, which this bridge turns into exactly one
// `setParamValue` command and therefore exactly one undo entry.
//
// The return trip matters just as much: undo/redo and project load change
// `paramValues` in the document, and the engine only hears about it through
// `ParamRegistry.load()`. Both directions are guarded against echo — a commit
// that became a command must not be written back, and a write-back must not
// look like a fresh commit.

import type {
  DocumentChange,
  DocumentStore,
  ParamId,
  ProjectCommands,
  ProjectSnapshot,
  Unsub,
} from "../types";
import type { AppParamRegistry } from "../params";
import { projectCommands } from "./commands";

export interface ParamBridgeOptions {
  /** Vocabulary to build the commands with. Defaults to `projectCommands`. */
  commands?: ProjectCommands | undefined;
  /** Ids present in the document that no live handle claims (device not
   *  mounted yet, definition changed). Reported rather than silently dropped. */
  onUnknownParams?: ((ids: readonly ParamId[]) => void) | undefined;
}

/**
 * Pushes document param values into the registry. Ids the registry does not
 * know are returned (SS4 `load` contract) — a device that is not mounted yet
 * will pick its value up when `ProjectEngine.applyDocument` loads them again.
 */
export function applyParamValues(
  registry: AppParamRegistry,
  values: Readonly<Record<ParamId, number>>,
): readonly ParamId[] {
  return registry.load(values);
}

/**
 * The whole document's param values, plus a descriptor default for every
 * registered param the document says nothing about (SS4: absent means
 * default, never zero). Ids the document carries for devices that are not
 * mounted come back from `load` as unclaimed, which is what makes them
 * reportable instead of silently dropped.
 */
function documentValuesForRegistry(
  registry: AppParamRegistry,
  doc: ProjectSnapshot,
): Record<ParamId, number> {
  const out: Record<ParamId, number> = { ...doc.paramValues };
  for (const handle of registry.list()) {
    const id = handle.desc.id;
    if (out[id] === undefined) out[id] = handle.desc.defaultValue;
  }
  return out;
}

/** The param ids a change touched, or `null` when the whole map moved (a
 *  project load, or a command that replaced `paramValues` wholesale). */
function touchedParamIds(change: DocumentChange): Set<ParamId> | null {
  const ids = new Set<ParamId>();
  for (const patch of change.patches) {
    if (patch.path.length === 0) return null;
    if (patch.path[0] !== "paramValues") continue;
    const id = patch.path[1];
    if (typeof id === "string") ids.add(id);
    else return null;
  }
  return ids;
}

/**
 * Wires an `AppParamRegistry` to a `DocumentStore` in both directions.
 * Returns an unsubscribe that removes both subscriptions.
 */
export function connectParamRegistry(
  store: DocumentStore,
  registry: AppParamRegistry,
  options: ParamBridgeOptions = {},
): Unsub {
  const commands = options.commands ?? projectCommands;
  const report = options.onUnknownParams;
  /** True while this bridge is writing INTO the registry, so the write-back
   *  can never be mistaken for a user gesture. */
  let applying = false;

  const unsubCommit = registry.onCommit((commit) => {
    if (applying) return;
    store.dispatch(commands.setParamValue(commit.id, commit.value));
  });

  const unsubChange = store.onChange((change) => {
    // A commit that BECAME this command is already in the registry; writing
    // it back would be an echo (SS13: subscribers use `source` to skip theirs).
    if (change.source === "command") return;
    const touched = touchedParamIds(change);
    let values: Record<ParamId, number>;
    if (touched === null) {
      values = documentValuesForRegistry(registry, change.doc);
    } else {
      if (touched.size === 0) return;
      values = {};
      for (const id of touched) {
        // An undone `setParamValue` may REMOVE the key (the param had no
        // document value before): the param returns to its descriptor default.
        const value = change.doc.paramValues[id];
        values[id] = value ?? registry.get(id)?.desc.defaultValue ?? 0;
      }
    }
    applying = true;
    try {
      const unknown = registry.load(values);
      if (unknown.length > 0 && report !== undefined) report(unknown);
    } finally {
      applying = false;
    }
  });

  return () => {
    unsubCommit();
    unsubChange();
  };
}
