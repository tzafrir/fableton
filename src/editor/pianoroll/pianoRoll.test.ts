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
import { createPianoRoll, createPianoRollView, createdNoteIds, redrawScopeOf } from "./pianoRoll";
import { KEY_GUTTER_WIDTH_PX } from "./keyNames";

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

/** The container is 800 wide; the key strip takes its cut off the left. */
const CANVAS_WIDTH_PX = 800 - KEY_GUTTER_WIDTH_PX;

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
  const view = createPianoRollView({
    container,
    store,
    commands,
    clipId,
    tool: options.tool,
    onSeek: (tick) => seeks.push(tick),
  });
  // The roll nests its canvas in a grid cell beside the key strip, and jsdom
  // reports a zero rect for every element, so the cell is sized by hand the
  // way `arrangement.test.ts` sizes its content cell. The canvas is narrower
  // than the container by exactly the strip's width.
  const cell = view.element.parentElement as HTMLElement;
  cell.getBoundingClientRect = rect(CANVAS_WIDTH_PX, 400);
  view.measure();
  view.element.getBoundingClientRect = rect(CANVAS_WIDTH_PX, 400);
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

  // The regression the id-diff exists for: a note created BEFORE existing
  // content does not sort last, so the patch stream's single `add` names an
  // untouched note. Selecting that one would point SS10's selection-centric
  // keyboard map at content the user never touched.
  it("selects a created note that sorts before the existing ones", () => {
    const { view, store, commands, clipId } = mount();
    store.dispatch(commands.addNotes(clipId, [{ id: "later", start: 1920, dur: 240, pitch: 64, vel: 90 }]));
    store.dispatch(commands.addNotes(clipId, [{ id: "first", start: 0, dur: 240, pitch: 55, vel: 90 }]));
    expect(view.selection.ids()).toEqual(["first"]);
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

  // SS10 "Snapping": "a fixed-grid override menu and a triplet toggle". The
  // menu is toolbar chrome, so it has to reach an ALREADY-MOUNTED editor.
  it("setGrid re-points snapping and note creation (SS10's override menu)", () => {
    const { view, store } = mount();
    const clipId = Object.keys(store.getState().clips)[0] ?? "";
    const element = view.element;
    const notesOf = () => store.getState().clips[clipId]?.notes ?? [];
    const dblclick = (x: number, y: number): void => {
      for (const detail of [1, 2]) {
        element.dispatchEvent(pointerEvent("pointerdown", x, y, detail));
        element.dispatchEvent(pointerEvent("pointerup", x, y, detail));
      }
    };

    // Default (adaptive at the default zoom) = a 1/16 note.
    dblclick(300, 182);
    expect(notesOf().some((note) => note.dur === 240)).toBe(true);

    view.setGrid({ mode: "fixed", denominator: 4 });
    dblclick(500, 214);
    const quarter = notesOf().find((note) => note.dur === 960);
    expect(quarter).toBeDefined();
    expect(quarter!.start % 960).toBe(0);

    // ...and the triplet toggle: a 1/4 triplet is 640 ticks.
    view.setGrid({ triplet: true });
    dblclick(700, 230);
    expect(notesOf().some((note) => note.dur === 640)).toBe(true);
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

  // The roll's viewport is CLIP-RELATIVE (SS10: `Note.start` is clip-relative,
  // and the grid dims past `clipLength`), while the transport and the
  // arrangement speak SONG ticks. The two crossings — the playhead in, the
  // ruler scrub out — are the only places the clip's start may appear.
  describe("the clip-relative time axis (SS9 coordinate discipline)", () => {
    const moveClipTo = (m: ReturnType<typeof mount>, tick: number) => {
      m.store.dispatch(m.commands.moveClips([m.clipId], { ticks: tick, tracks: 0 }));
    };
    const playheadX = (m: ReturnType<typeof mount>) =>
      m.view.element.querySelector<HTMLElement>(".fbl-playhead")?.style.transform;

    it("puts the playhead at the clip's origin when the transport is there", () => {
      const m = mount();
      moveClipTo(m, 7680);
      m.view.setPlayheadTicks(7680);
      expect(playheadX(m)).toBe("translateX(0px)");
      // ...and one quarter note into the clip, one quarter note in.
      m.view.setPlayheadTicks(7680 + 960);
      expect(playheadX(m)).toBe("translateX(48px)");
      m.view.dispose();
    });

    it("re-projects the playhead when a different clip is opened", () => {
      const m = mount();
      moveClipTo(m, 7680);
      m.view.setPlayheadTicks(7680);
      expect(playheadX(m)).toBe("translateX(0px)");
      // Back to a clip at song tick 0: the same transport position is now
      // 7680 ticks INTO the roll.
      moveClipTo(m, -7680);
      m.view.setClip(null);
      m.view.setClip(m.clipId);
      expect(playheadX(m)).toBe(`translateX(${String(Math.round(7680 * 0.05))}px)`);
      m.view.dispose();
    });

    it("reports a ruler scrub in SONG ticks", () => {
      const m = mount();
      moveClipTo(m, 7680);
      m.view.element.dispatchEvent(pointerEvent("pointerdown", 0, 5));
      m.view.element.dispatchEvent(pointerEvent("pointerup", 0, 5));
      // x = 0 is the clip's own start, which is song tick 7680 — not 0.
      expect(m.seeks).toEqual([7680]);
      m.view.dispose();
    });
  });

  // SS9's `ViewportLimits`: "maxTick/maxRow follow the content". Without this
  // the roll kept the kit's 1024-bar placeholder, so a one-bar clip could be
  // scrolled a thousand empty bars past its own end. The playhead's transform
  // is `(tick - scrollTicks) * pxPerTick`, so it reads the scroll back out.
  it("limits horizontal scrolling to the clip's own extent", () => {
    const { view, store, commands, clipId } = mount();
    const BAR = 3840;
    store.dispatch(commands.trimClips([{ id: clipId, start: 0, length: BAR }]));
    view.setPlayheadTicks(0);

    const scrollToTheEnd = (): void => {
      view.element.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 1e7, shiftKey: true, bubbles: true, cancelable: true }),
      );
    };
    scrollToTheEnd();
    const playhead = view.element.querySelector<HTMLElement>(".fbl-playhead");
    // One bar of clip plus the two-bar tail — not the kit's 1024-bar default.
    expect(playhead?.style.transform).toBe(`translateX(${String(-Math.round(BAR * 3 * 0.05))}px)`);

    // ...and the extent follows a lengthened clip.
    store.dispatch(commands.trimClips([{ id: clipId, start: 0, length: BAR * 4 }]));
    scrollToTheEnd();
    expect(playhead?.style.transform).toBe(`translateX(${String(-Math.round(BAR * 6 * 0.05))}px)`);
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
  it("reports the ids that were not there before", () => {
    const previous = new Set(["a", "b"]);
    expect(createdNoteIds(previous, [{ id: "new" }, { id: "a" }, { id: "b" }])).toEqual(["new"]);
    expect(createdNoteIds(previous, [{ id: "a" }, { id: "b" }])).toEqual([]);
  });

  // The reason this is an id diff and not a patch read: `clip.notes` is a
  // SORTED array, so immer reports a note inserted at the front as `replace`
  // on every shifted index plus one `add` carrying the note that ended up at
  // the tail — a pre-existing note.
  it("names the created note even when it does not sort last", () => {
    const previous = new Set(["a", "b"]);
    expect(createdNoteIds(previous, [{ id: "front" }, { id: "a" }, { id: "b" }])).toEqual(["front"]);
  });
});
