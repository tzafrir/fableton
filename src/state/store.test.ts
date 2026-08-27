import { describe, expect, it, vi } from "vitest";
import type { Command, DocumentChange } from "../types";
import { createDocumentStore } from "./store";
import { createEmptyProject } from "./project";
import { createSequentialIdFactory } from "./ids";
import { makeFixture, BAR, QUARTER, notes } from "./testing/fixture";

const setName = (name: string): Command => ({
  label: "Rename Project",
  run: (doc) => {
    doc.name = name;
  },
});

describe("createDocumentStore", () => {
  it("hands out a deep-frozen snapshot", () => {
    const { store } = makeFixture();
    const state = store.getState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.channels)).toBe(true);
    expect(() => {
      // @ts-expect-error the snapshot is deep-readonly by type AND at runtime
      state.name = "nope";
    }).toThrow();
  });

  it("drops undefined-valued keys on the way in (invariant 8)", () => {
    const ids = createSequentialIdFactory();
    const project = createEmptyProject({ ids });
    const clipId = Object.keys(project.clips)[0] ?? "";
    const clip = project.clips[clipId];
    if (clip !== undefined) clip.name = undefined;
    const store = createDocumentStore(project);
    expect(Object.hasOwn(store.getState().clips[clipId] ?? {}, "name")).toBe(false);
  });

  it("does not alias the document it was constructed with", () => {
    const project = createEmptyProject({ ids: createSequentialIdFactory() });
    const store = createDocumentStore(project);
    project.name = "mutated after construction";
    expect(store.getState().name).not.toBe("mutated after construction");
  });

  it("applies a command, records one history entry and emits the diff", () => {
    const { store } = makeFixture();
    const changes: DocumentChange[] = [];
    store.onChange((change) => changes.push(change));

    const result = store.dispatch(setName("Song"));

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.entry?.label).toBe("Rename Project");
    expect(result.patches).toEqual([{ op: "replace", path: ["name"], value: "Song" }]);
    expect(result.inverse).toEqual([{ op: "replace", path: ["name"], value: "Fixture" }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.source).toBe("command");
    expect(changes[0]?.doc.name).toBe("Song");
    expect(store.history()).toHaveLength(1);
  });

  it("reports a command that changes nothing as a noop and pushes no entry", () => {
    const { store } = makeFixture();
    const before = store.getState();
    const result = store.dispatch(setName("Fixture"));
    expect(result.status).toBe("noop");
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it("rejects a command whose canRun says no, without touching the document", () => {
    const { store } = makeFixture();
    const before = store.getState();
    const result = store.dispatch({
      label: "Impossible",
      run: (doc) => {
        doc.name = "changed";
      },
      canRun: () => "Not while playing.",
    });
    expect(result).toEqual({ status: "rejected", reason: "Not while playing." });
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it("undoes and redoes, reporting labels for the menu", () => {
    const { store } = makeFixture();
    store.dispatch(setName("One"));
    store.dispatch(setName("Two"));

    expect(store.undoLabel()).toBe("Rename Project");
    expect(store.redoLabel()).toBeUndefined();

    store.undo();
    expect(store.getState().name).toBe("One");
    expect(store.redoLabel()).toBe("Rename Project");
    store.undo();
    expect(store.getState().name).toBe("Fixture");
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBeNull();

    store.redo();
    store.redo();
    expect(store.getState().name).toBe("Two");
    expect(store.canRedo()).toBe(false);
    expect(store.redo()).toBeNull();
  });

  it("labels undo/redo changes with the source subscribers filter on", () => {
    const { store } = makeFixture();
    const sources: string[] = [];
    store.onChange((change) => sources.push(change.source));
    store.dispatch(setName("One"));
    store.undo();
    store.redo();
    expect(sources).toEqual(["command", "undo", "redo"]);
  });

  it("discards the redo tail when a new command lands after an undo", () => {
    const { store } = makeFixture();
    store.dispatch(setName("One"));
    store.dispatch(setName("Two"));
    store.undo();
    store.dispatch(setName("Three"));
    expect(store.canRedo()).toBe(false);
    expect(store.history()).toHaveLength(2);
    store.undo();
    expect(store.getState().name).toBe("One");
  });

  it("record:false applies without pushing an undo entry", () => {
    const { store } = makeFixture();
    const result = store.dispatch(setName("Silent"), { record: false });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.entry).toBeNull();
    expect(store.canUndo()).toBe(false);
    expect(store.getState().name).toBe("Silent");
  });

  it("coalesces consecutive dispatches sharing a key into one entry", () => {
    const { store, commands, clipId } = makeFixture();
    store.dispatch(commands.renameClip(clipId, "V"));
    store.dispatch(commands.renameClip(clipId, "Ve"));
    store.dispatch(commands.renameClip(clipId, "Verse"));

    expect(store.history()).toHaveLength(1);
    expect(store.getState().clips[clipId]?.name).toBe("Verse");

    // ONE undo unwinds the whole typing burst, back to no name at all.
    store.undo();
    expect(store.getState().clips[clipId]?.name).toBeUndefined();
    store.redo();
    expect(store.getState().clips[clipId]?.name).toBe("Verse");
  });

  it("stops coalescing once a different command intervenes", () => {
    const { store, commands, clipId } = makeFixture();
    store.dispatch(commands.renameClip(clipId, "V"));
    store.dispatch(commands.setClipColor(clipId, "#fff"));
    store.dispatch(commands.renameClip(clipId, "Verse"));
    expect(store.history()).toHaveLength(3);
  });

  it("coalesces per target, not per command kind", () => {
    const { store, commands, clipId, trackId } = makeFixture();
    store.dispatch(commands.renameClip(clipId, "A"));
    store.dispatch(commands.renameChannel(trackId, "B"));
    expect(store.history()).toHaveLength(2);
  });

  it("batches N commands into ONE undo entry", () => {
    const fixture = makeFixture();
    const { store, commands, clipId } = fixture;
    const result = store.batch("Delete Selection", [
      commands.addNotes(clipId, notes([[0, 60]])),
      commands.addNotes(clipId, notes([[QUARTER, 64]])),
      commands.renameClip(clipId, "Both"),
    ]);
    expect(result.status).toBe("applied");
    expect(store.history()).toHaveLength(1);
    expect(store.history()[0]?.label).toBe("Delete Selection");
    expect(store.getState().clips[clipId]?.notes).toHaveLength(2);

    store.undo();
    expect(store.getState().clips[clipId]?.notes).toHaveLength(0);
    expect(store.getState().clips[clipId]?.name).toBeUndefined();
  });

  it("lets a batched command see what the previous one did", () => {
    const fixture = makeFixture();
    const { store, commands, trackId } = fixture;
    const result = store.batch("Add Track With Clip", [
      commands.addTrack({ id: "chan-new", name: "New" }),
      commands.createClip({ id: "clip-new", trackId: "chan-new", start: 0, length: BAR }),
    ]);
    expect(result.status).toBe("applied");
    expect(store.getState().clips["clip-new"]?.trackId).toBe("chan-new");
    expect(trackId).not.toBe("chan-new");
  });

  it("rolls the whole batch back when one command is rejected", () => {
    const { store, commands, clipId } = makeFixture();
    const before = store.getState();
    const result = store.batch("Half Legal", [
      commands.addNotes(clipId, notes([[0, 60]])),
      commands.createClip({ trackId: "no-such-track", start: 0, length: BAR }),
    ]);
    expect(result.status).toBe("rejected");
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it("reports an empty or fully-noop batch as a noop", () => {
    const { store, commands, clipId } = makeFixture();
    expect(store.batch("Nothing", []).status).toBe("noop");
    expect(store.batch("Nothing", [commands.deleteNotes(clipId, [])]).status).toBe("noop");
    expect(store.canUndo()).toBe(false);
  });

  it("tracks dirtiness for the autosave debounce", () => {
    const { store } = makeFixture();
    expect(store.isDirty()).toBe(false);
    store.dispatch(setName("One"));
    expect(store.isDirty()).toBe(true);
    store.markSaved();
    expect(store.isDirty()).toBe(false);
    store.undo();
    expect(store.isDirty()).toBe(true);
  });

  it("replaces the document, clearing history and dirtiness", () => {
    const { store } = makeFixture();
    store.dispatch(setName("One"));
    const listener = vi.fn();
    store.onChange(listener);

    const next = createEmptyProject({ ids: createSequentialIdFactory("b"), name: "Loaded" });
    store.replaceDocument(next);

    expect(store.getState().name).toBe("Loaded");
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(store.isDirty()).toBe(false);
    const change = listener.mock.calls[0]?.[0] as DocumentChange;
    expect(change.source).toBe("load");
    expect(change.patches).toEqual([{ op: "replace", path: [], value: store.getState() }]);
  });

  it("can keep history across a replace, and undo back into the old document", () => {
    const { store } = makeFixture();
    store.dispatch(setName("One"));
    const next = createEmptyProject({ ids: createSequentialIdFactory("b"), name: "Loaded" });
    store.replaceDocument(next, { keepHistory: true, source: "replace" });
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.getState().name).toBe("Fixture");
  });

  it("clearHistory keeps the document and drops the stack", () => {
    const { store } = makeFixture();
    store.dispatch(setName("One"));
    store.clearHistory();
    expect(store.getState().name).toBe("One");
    expect(store.canUndo()).toBe(false);
    expect(store.history()).toHaveLength(0);
  });

  it("caps the history at the configured limit, oldest first", () => {
    const project = createEmptyProject({ ids: createSequentialIdFactory() });
    const store = createDocumentStore(project, { historyLimit: 3 });
    for (const name of ["a", "b", "c", "d", "e"]) store.dispatch(setName(name));
    expect(store.history()).toHaveLength(3);
    expect(store.history().map((entry) => entry.patches[0]?.value)).toEqual(["c", "d", "e"]);
    while (store.canUndo()) store.undo();
    expect(store.getState().name).toBe("b");
  });

  it("unsubscribes cleanly", () => {
    const { store } = makeFixture();
    const listener = vi.fn();
    const unsub = store.onChange(listener);
    store.dispatch(setName("One"));
    unsub();
    store.dispatch(setName("Two"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
