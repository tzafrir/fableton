// SS13 — "The document is plain serializable data behind a small store. All
// structural edits are commands; execution produces immer-style patches, and
// inverse patches make undo/redo mechanical."
//
//   dispatch(cmd) -> { patches, inverse } -> history.push -> subscribers get diffs
//
// The store is the ONLY thing that mutates the document. Everything a
// subscriber receives is a targeted diff (SS13: "reacting to 'effect moved
// from chain[2] to chain[0]' is a targeted update, not a full re-scan"), which
// is what M2's reconciler and the editors' repaint scheduling hang off.
//
// Ephemeral state (selection, viewport, hover, meters, the
// free/automated/overridden param state) never enters this store — it lives in
// Zustand next to the components that own it (SS15).

import { applyPatches, enablePatches, freeze, produceWithPatches, type Patch as ImmerPatch } from "immer";
import type {
  ChangeSource,
  Command,
  CommandResult,
  DispatchOptions,
  DocumentChange,
  DocumentStore,
  Draft,
  HistoryEntry,
  Patch,
  Project,
  ProjectSnapshot,
  Unsub,
} from "../types";

enablePatches();

/** Default cap on undo entries. Old entries fall off the bottom. */
export const DEFAULT_HISTORY_LIMIT = 500;

export interface DocumentStoreOptions {
  /** Maximum undo entries kept; oldest are dropped. Default 500. */
  historyLimit?: number | undefined;
  /** Wall clock for `HistoryEntry.at` (diagnostics only, never persisted). */
  now?: (() => number) | undefined;
}

export interface ReplaceDocumentOptions {
  label?: string | undefined;
  /** Keep the undo stack across the swap. The replacement is then pushed as
   *  an entry of its OWN (a whole-document inverse patch), so the first undo
   *  restores the previous document and the older entries apply to the
   *  document they were recorded against. Without that entry the stack would
   *  be patch paths into a document that is no longer there. */
  keepHistory?: boolean | undefined;
  /** Why the document changed; `"load"` (a file/autosave) by default. */
  source?: Extract<ChangeSource, "load" | "replace"> | undefined;
}

/**
 * The frozen `DocumentStore` plus the read-only history introspection the
 * undo menu and the tests want. Additive, exactly like `AppParamRegistry`:
 * an `AppDocumentStore` is a `DocumentStore` anywhere one is asked for.
 */
export interface AppDocumentStore extends DocumentStore {
  /** Entries oldest-first. `historyIndex()` is the index of the entry
   *  `undo()` would apply; `-1` when there is nothing to undo. */
  history(): readonly HistoryEntry[];
  historyIndex(): number;
  replaceDocument(project: Project, options?: ReplaceDocumentOptions): void;
}

/** immer's `Patch` is structurally what `types/commands.Patch` describes;
 *  going back the other way needs the readonly arrays copied out. */
function toImmerPatches(patches: readonly Patch[]): ImmerPatch[] {
  return patches.map((patch) => {
    const out: ImmerPatch = { op: patch.op, path: [...patch.path] };
    if (patch.op !== "remove") out.value = patch.value;
    return out;
  });
}

/**
 * Deep-frozen plain-JSON copy. The JSON round-trip is not paranoia: it drops
 * `undefined`-valued keys (document invariant 8) and rejects anything that is
 * not serializable, so a document that entered the store is a document that
 * can be saved.
 */
function normalize(project: Project): Project {
  return freeze(JSON.parse(JSON.stringify(project)) as Project, true);
}

export function createDocumentStore(
  initial: Project,
  options: DocumentStoreOptions = {},
): AppDocumentStore {
  const limit = Math.max(1, Math.floor(options.historyLimit ?? DEFAULT_HISTORY_LIMIT));
  const now = options.now ?? (() => Date.now());

  let state: Project = normalize(initial);
  let entries: HistoryEntry[] = [];
  /** Index of the entry `undo()` applies; `-1` = nothing to undo. */
  let index = -1;
  /** Coalesce key of the entry on top of the stack, when it had one. */
  let topKey: string | null = null;
  let nextEntryId = 1;
  let dirty = false;

  const listeners = new Set<(change: DocumentChange) => void>();

  const emit = (change: DocumentChange): void => {
    for (const cb of [...listeners]) cb(change);
  };

  const pushEntry = (label: string, patches: readonly Patch[], inverse: readonly Patch[], key: string | null): HistoryEntry => {
    // A new edit after an undo discards the redo tail.
    if (index < entries.length - 1) entries = entries.slice(0, index + 1);

    const top = index >= 0 ? entries[index] : undefined;
    if (key !== null && key === topKey && top !== undefined) {
      // Coalesced (SS13's "typing in a name field"): the two edits become one
      // undo entry. Patches concatenate forward, inverses concatenate BACKWARD
      // — undo must unwind the later edit first — which keeps coalescing exact
      // for any pair of commands, not just absolute-value replaces.
      const merged: HistoryEntry = {
        id: top.id,
        label,
        patches: [...top.patches, ...patches],
        inverse: [...inverse, ...top.inverse],
        at: now(),
      };
      entries[index] = merged;
      return merged;
    }

    const entry: HistoryEntry = {
      id: nextEntryId++,
      label,
      patches,
      inverse,
      at: now(),
    };
    entries.push(entry);
    if (entries.length > limit) entries = entries.slice(entries.length - limit);
    index = entries.length - 1;
    topKey = key;
    return entry;
  };

  /** Runs one command against `base`, returning the produced tuple or a
   *  rejection reason. */
  const runOne = (
    base: Project,
    command: Command,
  ): { ok: true; next: Project; patches: ImmerPatch[]; inverse: ImmerPatch[] } | { ok: false; reason: string } => {
    const reason = command.canRun?.(base as ProjectSnapshot) ?? null;
    if (reason !== null) return { ok: false, reason };
    const [next, patches, inverse] = produceWithPatches(base, (draft) => {
      command.run(draft as unknown as Draft<Project>);
    });
    return { ok: true, next, patches, inverse };
  };

  const commit = (
    source: Extract<ChangeSource, "command">,
    label: string,
    next: Project,
    patches: readonly Patch[],
    inverse: readonly Patch[],
    dispatchOptions: DispatchOptions,
    key: string | null,
  ): CommandResult => {
    state = next;
    dirty = true;
    const record = dispatchOptions.record ?? true;
    let entry: HistoryEntry | null = null;
    if (record) {
      entry = pushEntry(label, patches, inverse, key);
    } else {
      // An unrecorded edit is not a coalescing partner for the entry below it.
      topKey = null;
    }
    emit({ source, label, patches, inverse, doc: state });
    return { status: "applied", patches, inverse, entry };
  };

  const store: AppDocumentStore = {
    getState(): ProjectSnapshot {
      return state;
    },

    dispatch(command: Command, dispatchOptions: DispatchOptions = {}): CommandResult {
      const result = runOne(state, command);
      if (!result.ok) return { status: "rejected", reason: result.reason };
      if (result.patches.length === 0) return { status: "noop" };
      const key = dispatchOptions.coalesceKey ?? command.coalesceKey ?? null;
      return commit(
        "command",
        command.label,
        result.next,
        result.patches,
        result.inverse,
        dispatchOptions,
        key === "" ? null : key,
      );
    },

    batch(label: string, commands: readonly Command[], dispatchOptions: DispatchOptions = {}): CommandResult {
      if (commands.length === 0) return { status: "noop" };
      // Sequential produces, not one draft: each command's `canRun` must see
      // the document as the previous command left it (create-then-edit), and a
      // rejection anywhere must leave the store completely untouched.
      let working = state;
      const patches: Patch[] = [];
      const inverse: Patch[] = [];
      for (const command of commands) {
        const result = runOne(working, command);
        if (!result.ok) return { status: "rejected", reason: result.reason };
        if (result.patches.length === 0) continue;
        working = result.next;
        patches.push(...result.patches);
        // Undo unwinds the batch back to front.
        inverse.unshift(...result.inverse);
      }
      if (patches.length === 0) return { status: "noop" };
      const key = dispatchOptions.coalesceKey ?? null;
      return commit("command", label, working, patches, inverse, dispatchOptions, key === "" ? null : key);
    },

    undo(): HistoryEntry | null {
      if (index < 0) return null;
      const entry = entries[index];
      if (entry === undefined) return null;
      state = applyPatches(state, toImmerPatches(entry.inverse));
      index -= 1;
      topKey = null;
      dirty = true;
      emit({ source: "undo", label: entry.label, patches: entry.inverse, inverse: entry.patches, doc: state });
      return entry;
    },

    redo(): HistoryEntry | null {
      const entry = entries[index + 1];
      if (entry === undefined) return null;
      state = applyPatches(state, toImmerPatches(entry.patches));
      index += 1;
      topKey = null;
      dirty = true;
      emit({ source: "redo", label: entry.label, patches: entry.patches, inverse: entry.inverse, doc: state });
      return entry;
    },

    canUndo(): boolean {
      return index >= 0;
    },

    canRedo(): boolean {
      return index + 1 < entries.length;
    },

    undoLabel(): string | undefined {
      return index >= 0 ? entries[index]?.label : undefined;
    },

    redoLabel(): string | undefined {
      return entries[index + 1]?.label;
    },

    clearHistory(): void {
      entries = [];
      index = -1;
      topKey = null;
    },

    onChange(cb: (change: DocumentChange) => void): Unsub {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    replaceDocument(project: Project, replaceOptions: ReplaceDocumentOptions = {}): void {
      const previous = state;
      state = normalize(project);
      const label = replaceOptions.label ?? "Load Project";
      const patches: Patch[] = [{ op: "replace", path: [], value: state }];
      const inverse: Patch[] = [{ op: "replace", path: [], value: previous }];
      if (replaceOptions.keepHistory === true) {
        // The kept entries are patch PATHS into the document that just left.
        // Recording the swap itself as an entry is what keeps them applicable:
        // the first undo puts the old document back, and only then do the
        // older inverses run — against the document they were recorded on.
        pushEntry(label, patches, inverse, null);
      } else {
        entries = [];
        index = -1;
      }
      topKey = null;
      // A freshly loaded document matches what is on disk.
      dirty = false;
      const source: ChangeSource = replaceOptions.source ?? "load";
      emit({ source, label, patches, inverse, doc: state });
    },

    isDirty(): boolean {
      return dirty;
    },

    markSaved(): void {
      dirty = false;
    },

    history(): readonly HistoryEntry[] {
      return entries;
    },

    historyIndex(): number {
      return index;
    },
  };

  return store;
}
