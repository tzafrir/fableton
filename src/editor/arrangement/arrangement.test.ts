// The assembled view, mounted headlessly in jsdom over the kit's fake canvas.
//
// What is asserted here is the WIRING SS9 fixes and nothing else: which layer
// repaints when, that playback never dirties a canvas, that a gesture on the
// mounted editor produces one command and a live selection, and that the
// bounded-count DOM chrome (lane headers, ruler) follows the document.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorPoint, Modifiers } from "../../types/gesture";
import { createDocumentStore, createProjectCommands, createSequentialIdFactory } from "../../state";
import { editorPointOf, modifiers } from "../kit";
import { fakeContextOf, installFakeCanvas2D, uninstallFakeCanvas2D } from "../kit/testing/fakeCanvas";
import { createArrangementView, createdClipIds, type KitArrangementView } from "./arrangement";
import { BAR, CLIP_1, CLIP_2, MASTER, TRACK_A, makeProject } from "./testing/harness";

const NO_MODS: Modifiers = modifiers({});

describe("createdClipIds", () => {
  it("reads clip ids a command minted out of its patches", () => {
    expect(
      createdClipIds([
        { op: "add", path: ["clips", "clip-9"], value: {} },
        { op: "replace", path: ["clips", "clip-1", "start"], value: 0 },
        { op: "add", path: ["clips", "clip-9", "notes", 0], value: {} },
      ]),
    ).toEqual(["clip-9"]);
  });
});

describe("the mounted arrangement", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
    uninstallFakeCanvas2D();
  });

  function mount(overrides: { onOpenClip?: (id: string) => void; onSelectChannel?: (id: string) => void } = {}) {
    installFakeCanvas2D();
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ width: 900, height: 300, top: 0, left: 0, right: 900, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(container);
    const store = createDocumentStore(makeProject());
    const commands = createProjectCommands(createSequentialIdFactory("m"));
    const view: KitArrangementView = createArrangementView({
      container,
      store,
      commands,
      dpr: 1,
      ...overrides,
    });
    // jsdom reports a zero rect for every element, so the kit's measure/
    // ResizeObserver path sizes the editor to nothing: do it by hand, after
    // letting `measure()` run once the way a real mount would.
    view.measure();
    view.host.viewport.setSize(768, 274);
    view.host.renderer.resize(768, 274);
    cleanups.push(() => {
      view.dispose();
      container.remove();
    });
    const canvases = [...view.host.renderer.element.querySelectorAll("canvas")];
    return { view, store, commands, container, canvases };
  }

  const canvasOf = (canvases: HTMLCanvasElement[], kind: "grid" | "content" | "overlay") => {
    const canvas = canvases.find((c) => c.className.includes(`fbl-layer-${kind}`));
    if (canvas === undefined) throw new Error(`no ${kind} canvas`);
    return fakeContextOf(canvas);
  };

  const point = (view: KitArrangementView, x: number, y: number): EditorPoint =>
    editorPointOf(view.host.viewport, x, y);

  it("mounts a ruler, one header per channel, and the three SS9 layers", () => {
    const { view, canvases } = mount();
    expect(view.element.parentElement).not.toBeNull();
    expect(view.element.querySelector(".fbl-arr-ruler")).not.toBeNull();
    const headers = [...view.element.querySelectorAll(".fbl-arr-header .fbl-arr-header-name")];
    expect(headers.map((el) => el.textContent)).toEqual(["Track A", "Track B", "Master"]);
    expect(canvases.map((c) => c.className.replace("fbl-layer ", ""))).toEqual([
      "fbl-layer-grid",
      "fbl-layer-content",
      "fbl-layer-overlay",
    ]);
  });

  it("draws the clips on the content layer", () => {
    const { view, canvases } = mount();
    view.host.renderer.flush();
    expect(canvasOf(canvases, "content").callsOf("fillRect").length).toBeGreaterThan(0);
  });

  it("moves the playhead without invalidating a canvas (SS9)", () => {
    const { view, canvases } = mount();
    view.host.renderer.flush();
    const content = canvasOf(canvases, "content");
    const before = content.calls.length;
    view.setPlayheadTicks(BAR);
    view.host.renderer.flush();
    expect(content.calls.length).toBe(before);
    const playhead = view.element.querySelector<HTMLElement>(".fbl-playhead");
    expect(playhead?.style.transform).toBe("translateX(192px)");
    expect(view.playheadTicks).toBe(BAR);
  });

  it("repaints only the OVERLAY when the selection changes", () => {
    const { view, canvases } = mount();
    view.host.renderer.flush();
    const content = canvasOf(canvases, "content");
    const overlay = canvasOf(canvases, "overlay");
    const contentBefore = content.calls.length;
    const overlayBefore = overlay.calls.length;
    view.selection.set([CLIP_1]);
    view.host.renderer.flush();
    expect(content.calls.length).toBe(contentBefore);
    expect(overlay.calls.length).toBeGreaterThan(overlayBefore);
  });

  it("repaints the content layer when a clip changes in the document", () => {
    const { view, store, commands, canvases } = mount();
    view.host.renderer.flush();
    const content = canvasOf(canvases, "content");
    const before = content.calls.length;
    store.dispatch(commands.moveClips([CLIP_1], { ticks: BAR, tracks: 0 }));
    view.host.renderer.flush();
    expect(content.calls.length).toBeGreaterThan(before);
    expect(view.scene.clip(CLIP_1)?.start).toBe(BAR);
  });

  it("rebuilds the lane headers when the lane set changes", () => {
    const { view, store, commands } = mount();
    store.dispatch(commands.addTrack({ id: "chan-c", name: "Track C", index: 1 }));
    const headers = [...view.element.querySelectorAll(".fbl-arr-header-name")];
    expect(headers.map((el) => el.textContent)).toEqual(["Track A", "Track C", "Track B", "Master"]);
  });

  it("drops deleted clips from the ephemeral selection", () => {
    const { view, store, commands } = mount();
    view.selection.set([CLIP_1, CLIP_2]);
    store.dispatch(commands.deleteClips([CLIP_1]));
    expect(view.selection.ids()).toEqual([CLIP_2]);
  });

  it("creates a clip from a real pointer sequence and selects it", () => {
    const { view, store } = mount();
    const gestures = view.host.gestures;
    const y = view.host.viewport.pxPerRow / 2;
    gestures.pointerDown({ pointerId: 1, point: point(view, 600, y), button: 0, buttons: 1, modifiers: NO_MODS });
    gestures.pointerMove({ pointerId: 1, point: point(view, 700, y), button: 0, buttons: 1, modifiers: NO_MODS });
    gestures.pointerUp({ pointerId: 1, point: point(view, 700, y), button: 0, buttons: 0, modifiers: NO_MODS });

    const clips = Object.values(store.getState().clips);
    expect(clips).toHaveLength(4);
    const created = clips.find((clip) => clip.start === 12000);
    expect(created?.trackId).toBe(TRACK_A);
    expect(view.selection.ids()).toEqual([created?.id]);
    expect(store.undoLabel()).toBe("Create Clip");
  });

  it("opens the piano roll on a double-clicked clip", () => {
    const onOpenClip = vi.fn();
    const { view } = mount({ onOpenClip });
    const gestures = view.host.gestures;
    const y = view.host.viewport.pxPerRow / 2;
    gestures.pointerDown({ pointerId: 1, point: point(view, 100, y), button: 0, buttons: 1, modifiers: NO_MODS, clickCount: 2 });
    gestures.pointerUp({ pointerId: 1, point: point(view, 100, y), button: 0, buttons: 0, modifiers: NO_MODS, clickCount: 2 });
    expect(onOpenClip).toHaveBeenCalledWith(CLIP_1);
  });

  it("reports a lane header click and mutes from the header", () => {
    const onSelectChannel = vi.fn();
    const { view, store } = mount({ onSelectChannel });
    const header = view.element.querySelector<HTMLElement>(".fbl-arr-header");
    header?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(onSelectChannel).toHaveBeenCalledWith(TRACK_A);

    const mute = header?.querySelector<HTMLButtonElement>("button");
    mute?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(store.getState().channels[TRACK_A]?.mute).toBe(true);
  });

  it("splits and loops the selection through the toolbar verbs", () => {
    const { view, store } = mount();
    view.selection.set([CLIP_1]);
    view.setPlayheadTicks(1920);
    expect(view.splitSelection()).toBe(1);
    expect(Object.keys(store.getState().clips)).toHaveLength(4);

    view.selection.set([CLIP_2]);
    expect(view.toggleLoop()).toBe(1);
    expect(store.getState().clips[CLIP_2]?.loop).toEqual({ start: 0, end: BAR });
  });

  it("reveals a clip by scrolling the minimum distance", () => {
    const { view } = mount();
    const viewport = view.host.viewport;
    // Clip 2 is already on screen at the mounted width: revealing is a no-op.
    view.reveal(CLIP_2);
    expect(viewport.scrollTicks).toBe(0);
    // Narrow the editor until it is off screen, and it scrolls into view.
    viewport.setSize(200, 274);
    view.reveal(CLIP_2);
    expect(viewport.scrollTicks).toBeGreaterThan(0);
    expect(viewport.xOf(BAR * 2)).toBeLessThanOrEqual(viewport.widthPx);
  });

  it("keeps the master lane out of reach of clips", () => {
    const { view } = mount();
    expect(view.scene.isTrackRow(view.scene.rowOfChannel(MASTER))).toBe(false);
  });

  it("re-reads the ruler when a different document is loaded", () => {
    const { view, store } = mount();
    const loaded = { ...makeProject(), timeSignature: { numerator: 3, denominator: 4 } };
    store.replaceDocument(loaded);
    view.setPlayheadTicks(2880); // one 3/4 bar
    const readout = view.element.querySelector(".fbl-arr-readout");
    expect(readout?.textContent).toBe("2.1.000  0:01.500");
  });

  it("tears everything down on dispose", () => {
    installFakeCanvas2D();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const store = createDocumentStore(makeProject());
    const view = createArrangementView({
      container,
      store,
      commands: createProjectCommands(createSequentialIdFactory("d")),
      dpr: 1,
    });
    view.dispose();
    view.dispose(); // idempotent
    expect(container.children).toHaveLength(0);
    container.remove();
  });
});
