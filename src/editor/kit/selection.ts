// SS13 — "Selection, viewport, and meters are ephemeral state outside the
// document — never undoable, never saved into history."
//
// One implementation so SS10's "`Shift` adds, `Ctrl` toggles" behaves
// identically in the piano roll, the arrangement, and M3's automation lanes.

import type { Unsub } from "../../types/common";
import type { SelectionModel } from "../../types/editor";
import type { Modifiers } from "../../types/gesture";

export function createSelectionModel<TId extends string = string>(
  initial?: Iterable<TId>,
): SelectionModel<TId> {
  // Insertion-ordered so `ids()` is stable across renders and test runs.
  let ids = new Set<TId>(initial ?? []);
  const listeners = new Set<(next: readonly TId[]) => void>();

  const notify = (): void => {
    const snapshot = [...ids];
    for (const cb of [...listeners]) cb(snapshot);
  };

  const sameAs = (next: Set<TId>): boolean => {
    if (next.size !== ids.size) return false;
    for (const id of next) if (!ids.has(id)) return false;
    return true;
  };

  const replace = (next: Set<TId>): void => {
    if (sameAs(next)) return;
    ids = next;
    notify();
  };

  return {
    get size() {
      return ids.size;
    },
    has(id: TId) {
      return ids.has(id);
    },
    ids() {
      return [...ids];
    },
    set(next: Iterable<TId>) {
      replace(new Set(next));
    },
    add(next: Iterable<TId>) {
      const merged = new Set(ids);
      for (const id of next) merged.add(id);
      replace(merged);
    },
    remove(next: Iterable<TId>) {
      const merged = new Set(ids);
      for (const id of next) merged.delete(id);
      replace(merged);
    },
    toggle(next: Iterable<TId>) {
      const merged = new Set(ids);
      for (const id of next) {
        if (merged.has(id)) merged.delete(id);
        else merged.add(id);
      }
      replace(merged);
    },
    clear() {
      replace(new Set());
    },
    onChange(cb: (next: readonly TId[]) => void): Unsub {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * SS10 `Pending` -> click: "select (`Shift` adds, `Ctrl` toggles)". Written
 * once here so every editor's click handler is a one-liner and the three
 * behaviours never drift apart.
 *
 * `primary` (Cmd on macOS, Ctrl elsewhere) is the toggle modifier, matching
 * the rest of SS10's `Cmd/Ctrl+...` map.
 */
export function applySelectionClick<TId extends string>(
  selection: SelectionModel<TId>,
  id: TId,
  modifiers: Modifiers,
): void {
  if (modifiers.shift) {
    selection.add([id]);
    return;
  }
  if (modifiers.primary) {
    selection.toggle([id]);
    return;
  }
  // A plain click on an already-selected item keeps the selection, so a drag
  // that starts on one member of a multi-selection moves the whole group.
  if (selection.has(id)) return;
  selection.set([id]);
}
