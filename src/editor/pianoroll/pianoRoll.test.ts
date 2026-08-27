// The mounted view: the piano roll as the app shell sees it (types/editor's
// `CreatePianoRoll`). jsdom, the kit's fake canvas, and real DOM events — the
// FSM itself is covered headlessly in fsm.test.ts.

import { beforeAll, describe, expect, it } from "vitest";
import type { CreatePianoRoll } from "../../types/editor";
import { createProjectCommands } from "../../state/commands";
import { createSequentialIdFactory } from "../../state/ids";
import { createEmptyProject } from "../../state/project";
import { createDocumentStore } from "../../state/store";
import { installFakeCanvas2D } from "../kit/testing/fakeCanvas";
import { createPianoRoll, createdNoteIds, redrawScopeOf } from "./pianoRoll";

beforeAll(() => {
  installFakeCanvas2D();
});

// The factory satisfies the frozen contract shape.
const _contract: CreatePianoRoll = createPianoRoll;
void _contract;

function rect(width: number, height: number): () => DOMRect {
  return () =>
    ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function pointerEvent(type: string, x: number, y: number, detail = 1): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons: type === "pointerup" ? 0 : 1,
    detail,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event as PointerEvent;
}

function mount(options: { tool?: "select" | "pencil" } = {}) {
  const ids = createSequentialIdFactory();
  const commands = createProjectCommands(ids);
  const project = createEmptyProject({ ids, name: "Mount" });
  const clipId = Object.keys(project.clips)[0] ?? "";
  const store = createDocumentStore(project, { now: () => 0 });
  store.dispatch(
    commands.addNotes(clipId, [{ id: "n1", start: 0, dur: 480, pitch: 60, vel: 100 }]),
  );
  store.clearHistory();

  const container = document.createElement("div");
  container.getBoundingClientRect = rect(800, 400);
  document.body.appendChild(container);

  const seeks: number[] = [];
  const view = createPianoRoll({
    container,
    store,
    commands,
    clipId,
    tool: options.tool,
    onSeek: (tick) => seeks.push(tick),
  });
  view.element.getBoundingClientRect = rect(800, 400);
  return { view, store, commands, clipId, container, seeks };
}

describe("mounting", () => {
  it("fills the container and is keyboard-focusable", () => {
    const { view, container } = mount();
    expect(container.contains(view.element)).toBe(true);
    expect(view.element.tabIndex).toBe(0);
    expect(view.element.querySelectorAll("canvas")).toHaveLength(3);
    view.focus();
    expect(document.activeElement).toBe(view.element);
    view.dispose();
  });

  it("frames the clip's pitches: the only note lands mid-grid", () => {
    const { view } = mount();
    // 308 px of note grid / 16 px rows = 19.25 rows, centred on row 67
    // (pitch 60) -> scrollRows 57.375 -> the note's row starts at y = 174.
    view.element.dispatchEvent(pointerEvent("pointerdown", 8, 182));
    view.element.dispatchEvent(pointerEvent("pointerup", 8, 182));
    expect(view.selection.ids()).toEqual(["n1"]);
    view.dispose();
  });
});

describe("the playhead (SS9: DOM only)", () => {
  it("moves by transform and never touches a canvas", () => {
    const { view } = mount();
    const playhead = view.element.querySelector(".fbl-playhead") as HTMLElement;
    expect(playhead).not.toBeNull();
    view.setPlayheadTicks(960);
    expect(playhead.style.transform).toBe("translateX(48px)");
    view.setPlayheadTicks(1920);
    expect(playhead.style.transform).toBe("translateX(96px)");
    view.dispose();
  });
});

describe("document subscription", () => {
  it("selects notes created by a command", () => {
    const { view, store, commands, clipId } = mount();
    store.dispatch(commands.addNotes(clipId, [{ id: "new", start: 960, dur: 240, pitch: 62, vel: 90 }]));
    expect(view.selection.ids()).toEqual(["new"]);
    view.dispose();
  });

  it("drops deleted notes from the selection", () => {
    const { view, store, commands, clipId } = mount();
    view.selection.set(["n1"]);
    store.dispatch(commands.deleteNotes(clipId, ["n1"]));
    expect(view.selection.ids()).toEqual([]);
    view.dispose();
  });

  it("stops listening after dispose", () => {
    const { view, store, commands, clipId } = mount();
    view.dispose();
    store.dispatch(commands.addNotes(clipId, [{ id: "late", start: 0, dur: 240, pitch: 62, vel: 90 }]));
    expect(view.selection.ids()).toEqual([]);
  });
});

describe("clip and tool", () => {
  it("setClip swaps the edited clip and clears the selection", () => {
    const { view, store, commands, clipId } = mount();
    view.selection.set(["n1"]);
    expect(view.clipId).toBe(clipId);
    view.setClip(null);
    expect(view.clipId).toBeNull();
    expect(view.selection.ids()).toEqual([]);
    view.setClip(clipId);
    expect(view.clipId).toBe(clipId);
    void store;
    void commands;
    view.dispose();
  });

  it("setTool switches to the pencil", () => {
    const { view } = mount();
    view.setTool("pencil");
    view.setTool("select");
    view.dispose();
  });
});

describe("real DOM events reach the FSM", () => {
  it("a drag on a note body commits exactly one move command", () => {
    const { view, store } = mount();
    const element = view.element;
    element.dispatchEvent(pointerEvent("pointerdown", 8, 182));
    element.dispatchEvent(pointerEvent("pointermove", 20, 182));
    element.dispatchEvent(pointerEvent("pointerup", 20, 182));
    expect(view.selection.ids()).toEqual(["n1"]);
    // 12 px = 240 ticks at the default zoom, snapped to the 1/16 grid.
    expect(store.getState().clips[Object.keys(store.getState().clips)[0] ?? ""]?.notes[0]?.start).toBe(240);
    expect(store.undoLabel()).toBe("Move Notes");
    view.dispose();
  });

  it("the cursor follows the hovered zone", () => {
    const { view } = mount();
    view.element.dispatchEvent(pointerEvent("pointermove", 8, 182));
    expect(view.element.style.cursor).toBe("move");
    view.element.dispatchEvent(pointerEvent("pointermove", 400, 182));
    expect(view.element.style.cursor).toBe("default");
    view.dispose();
  });

  it("seeks from the ruler", () => {
    const { view, seeks } = mount();
    view.element.dispatchEvent(pointerEvent("pointerdown", 48, 5));
    view.element.dispatchEvent(pointerEvent("pointerup", 48, 5));
    expect(seeks).toEqual([960]);
    view.dispose();
  });
});

describe("redrawScopeOf (SS13 targeted updates)", () => {
  it("ignores edits to other clips and to params", () => {
    expect(redrawScopeOf([{ op: "replace", path: ["clips", "other", "notes", 0, "pitch"], value: 61 }], "c1")).toBe("none");
    expect(redrawScopeOf([{ op: "replace", path: ["paramValues", "chan:1/vol"], value: -6 }], "c1")).toBe("none");
  });

  it("redraws content for this clip and everything for a tempo change", () => {
    expect(redrawScopeOf([{ op: "replace", path: ["clips", "c1", "notes", 0, "pitch"], value: 61 }], "c1")).toBe("content");
    expect(redrawScopeOf([{ op: "add", path: ["clips", "c1"], value: {} }], "c1")).toBe("content");
    expect(redrawScopeOf([{ op: "replace", path: ["timeSignature"], value: {} }], "c1")).toBe("all");
    expect(redrawScopeOf([{ op: "replace", path: [], value: {} }], "c1")).toBe("all");
  });
});

describe("createdNoteIds", () => {
  it("reads ids out of the patch stream (SS13)", () => {
    expect(
      createdNoteIds(
        [
          { op: "add", path: ["clips", "c1", "notes", 0], value: { id: "a" } },
          { op: "add", path: ["clips", "other", "notes", 0], value: { id: "b" } },
          { op: "replace", path: ["clips", "c1", "notes", 0, "pitch"], value: 61 },
        ],
        "c1",
      ),
    ).toEqual(["a"]);
  });
});
