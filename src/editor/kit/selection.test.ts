// SS13 — selection is EPHEMERAL: never in the document, never undoable.
// SS10 — "click: select (`Shift` adds, `Ctrl` toggles)".

import { describe, expect, it, vi } from "vitest";
import type { NoteId } from "../../types/ids";
import { applySelectionClick, createSelectionModel } from "./selection";
import { modifiers } from "./points";

describe("selection model", () => {
  it("starts empty unless seeded", () => {
    expect(createSelectionModel().size).toBe(0);
    expect(createSelectionModel(["a", "b"]).ids()).toEqual(["a", "b"]);
  });

  it("set replaces, add unions, remove subtracts, toggle flips", () => {
    const s = createSelectionModel<NoteId>();
    s.set(["a", "b"]);
    expect(s.ids()).toEqual(["a", "b"]);
    s.add(["c"]);
    expect(s.ids()).toEqual(["a", "b", "c"]);
    s.remove(["b"]);
    expect(s.ids()).toEqual(["a", "c"]);
    s.toggle(["a", "d"]);
    expect(s.ids()).toEqual(["c", "d"]);
    expect(s.has("c")).toBe(true);
    s.clear();
    expect(s.size).toBe(0);
  });

  it("keeps insertion order so redraws are stable", () => {
    const s = createSelectionModel();
    s.set(["z", "m", "a"]);
    expect(s.ids()).toEqual(["z", "m", "a"]);
  });

  it("notifies only on a real change", () => {
    const s = createSelectionModel();
    const seen = vi.fn();
    const unsub = s.onChange(seen);
    s.set(["a"]);
    expect(seen).toHaveBeenCalledTimes(1);
    s.set(["a"]);
    expect(seen).toHaveBeenCalledTimes(1);
    s.add(["a"]);
    expect(seen).toHaveBeenCalledTimes(1);
    s.remove(["nope"]);
    expect(seen).toHaveBeenCalledTimes(1);
    s.clear();
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
    s.set(["b"]);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("hands subscribers a snapshot, not a live view", () => {
    const s = createSelectionModel();
    let captured: readonly string[] = [];
    s.onChange((ids) => {
      captured = ids;
    });
    s.set(["a"]);
    s.set(["a", "b"]);
    expect(captured).toEqual(["a", "b"]);
  });
});

describe("applySelectionClick (SS10)", () => {
  it("a plain click selects only that item", () => {
    const s = createSelectionModel();
    s.set(["a", "b"]);
    applySelectionClick(s, "c", modifiers());
    expect(s.ids()).toEqual(["c"]);
  });

  it("Shift ADDS to the selection", () => {
    const s = createSelectionModel();
    s.set(["a"]);
    applySelectionClick(s, "b", modifiers({ shift: true }));
    expect(s.ids()).toEqual(["a", "b"]);
  });

  it("the primary modifier TOGGLES", () => {
    const s = createSelectionModel();
    s.set(["a", "b"]);
    applySelectionClick(s, "b", modifiers({ primary: true }));
    expect(s.ids()).toEqual(["a"]);
    applySelectionClick(s, "b", modifiers({ primary: true }));
    expect(s.ids()).toEqual(["a", "b"]);
  });

  it("a plain click on an already-selected item KEEPS the group", () => {
    // This is what lets a drag that starts on one member of a multi-selection
    // move all of them (SS10 DragMove over n notes).
    const s = createSelectionModel();
    s.set(["a", "b", "c"]);
    applySelectionClick(s, "b", modifiers());
    expect(s.ids()).toEqual(["a", "b", "c"]);
  });
});
