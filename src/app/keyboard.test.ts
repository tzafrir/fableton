// SS18-M1 "global undo/redo through the command bus" — headless (SS15): a
// synthetic `KeyLike` object drives the handler, exactly the discipline the
// editor kit's own gesture-engine tests use.

import { describe, expect, it } from "vitest";
import { createDocumentStore, createEmptyProject, createProjectCommands, createSequentialIdFactory } from "../state";
import { createUndoRedoHandler, isEditableTarget, type KeyLike } from "./keyboard";

function makeEvent(overrides: Partial<KeyLike> & { key: string }): KeyLike & { prevented: boolean } {
  const event = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    repeat: false,
    prevented: false,
    ...overrides,
    preventDefault(this: { prevented: boolean }): void {
      this.prevented = true;
    },
  };
  return event;
}

function makeStore() {
  const ids = createSequentialIdFactory();
  const store = createDocumentStore(createEmptyProject({ ids }));
  const commands = createProjectCommands(ids);
  return { store, commands };
}

describe("createUndoRedoHandler", () => {
  it("Cmd/Ctrl+Z undoes the last command", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("Renamed"));
    expect(store.getState().name).toBe("Renamed");

    const handle = createUndoRedoHandler(store);
    const event = makeEvent({ key: "z", ctrlKey: true });
    expect(handle(event)).toBe("undo");
    expect(store.getState().name).not.toBe("Renamed");
    expect(event.prevented).toBe(true);
  });

  it("Cmd/Ctrl+Shift+Z redoes (SS18-M1's spelling)", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("Renamed"));
    store.undo();
    expect(store.getState().name).not.toBe("Renamed");

    const handle = createUndoRedoHandler(store);
    expect(handle(makeEvent({ key: "z", ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(store.getState().name).toBe("Renamed");
  });

  it("Cmd/Ctrl+Y also redoes (Windows/Linux convention)", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("Renamed"));
    store.undo();

    const handle = createUndoRedoHandler(store);
    expect(handle(makeEvent({ key: "y", metaKey: true }))).toBe("redo");
    expect(store.getState().name).toBe("Renamed");
  });

  it("works with metaKey (macOS) as well as ctrlKey", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("Renamed"));

    const handle = createUndoRedoHandler(store);
    expect(handle(makeEvent({ key: "z", metaKey: true }))).toBe("undo");
    expect(store.getState().name).not.toBe("Renamed");
  });

  it("ignores plain Z with no modifier", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("Renamed"));

    const handle = createUndoRedoHandler(store);
    const event = makeEvent({ key: "z" });
    expect(handle(event)).toBe("ignored");
    expect(event.prevented).toBe(false);
    expect(store.getState().name).toBe("Renamed");
  });

  // Holding the key down is how a user walks back through a long edit chain,
  // so auto-repeat steps the history one entry per repeat (SS18-M1's "undo
  // everywhere" is only usable if the history is walkable).
  it("honours key-repeat: holding the key steps the history", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("One"));
    store.dispatch(commands.renameProject("Two"));
    store.dispatch(commands.renameProject("Three"));

    const handle = createUndoRedoHandler(store);
    expect(handle(makeEvent({ key: "z", ctrlKey: true }))).toBe("undo");
    expect(handle(makeEvent({ key: "z", ctrlKey: true, repeat: true }))).toBe("undo");
    expect(handle(makeEvent({ key: "z", ctrlKey: true, repeat: true }))).toBe("undo");
    expect(store.getState().name).toBe("Untitled");
    expect(store.canUndo()).toBe(false);
  });

  it("backs off while a text field is focused, so field-local undo still works", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("Renamed"));

    const input = document.createElement("input");
    document.body.append(input);
    try {
      const handle = createUndoRedoHandler(store);
      const event = makeEvent({ key: "z", ctrlKey: true, target: input });
      expect(handle(event)).toBe("ignored");
      expect(event.prevented).toBe(false);
      expect(store.getState().name).toBe("Renamed");
    } finally {
      input.remove();
    }
  });

  it("does not back off for a canvas editor host (not a text field)", () => {
    const { store, commands } = makeStore();
    store.dispatch(commands.renameProject("Renamed"));

    const host = document.createElement("div");
    host.tabIndex = 0;
    document.body.append(host);
    try {
      const handle = createUndoRedoHandler(store);
      expect(handle(makeEvent({ key: "z", ctrlKey: true, target: host }))).toBe("undo");
    } finally {
      host.remove();
    }
  });

  it("respects contenteditable as an editable target", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.append(div);
    try {
      expect(isEditableTarget(div)).toBe(true);
    } finally {
      div.remove();
    }
  });

  it("ignored outcome never calls preventDefault (browser/native undo still fires)", () => {
    const { store } = makeStore();
    const handle = createUndoRedoHandler(store);
    const event = makeEvent({ key: "a", ctrlKey: true });
    expect(handle(event)).toBe("ignored");
    expect(event.prevented).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("is false for null and for non-HTMLElements", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("is true for a %s element", (tag) => {
    const el = document.createElement(tag);
    expect(isEditableTarget(el)).toBe(true);
  });

  it("is false for a plain div", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
  });
});
