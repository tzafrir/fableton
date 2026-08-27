// SS15's imperative bridge, tested where it actually lives.
//
// "Editors mount as opaque canvas components with an imperative bridge" — the
// bridge is these two components, and SS15's position is that load-bearing
// logic is provable headlessly. What is asserted here is only the bridge:
// that a React prop change reaches the LIVE view (never a remount), and that
// the view's callbacks reach the React props. The editors' own behaviour is
// covered in their packages.

import { projectCommands } from "../../state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KitArrangementView } from "../../editor/arrangement/arrangement";
import { installFakeCanvas2D, uninstallFakeCanvas2D } from "../../editor/kit/testing/fakeCanvas";
import { createDocumentStore, createProjectCommands, createSequentialIdFactory, createEmptyProject } from "../../state";
import type { ArrangementView, ClipId, DocumentStore, PianoRollView, ProjectCommands } from "../../types";
import { ArrangementPanel } from "./ArrangementPanel";
import { PianoRollPanel } from "./PianoRollPanel";
import { Toolbar, type ToolbarProps } from "./Toolbar";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const SIZE = { width: 900, height: 300 };

function stubRect(el: HTMLElement): void {
  el.getBoundingClientRect = () =>
    ({
      width: SIZE.width,
      height: SIZE.height,
      top: 0,
      left: 0,
      right: SIZE.width,
      bottom: SIZE.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function pointerEvent(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons: type === "pointerup" ? 0 : 1,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event as PointerEvent;
}

function project(): { store: DocumentStore; commands: ProjectCommands; clipId: ClipId } {
  const ids = createSequentialIdFactory("p");
  const commands = createProjectCommands(ids);
  const doc = createEmptyProject({ ids, name: "Bridge" });
  const clipId = Object.keys(doc.clips)[0] ?? "";
  return { store: createDocumentStore(doc, { now: () => 0 }), commands, clipId };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installFakeCanvas2D();
  container = document.createElement("div");
  stubRect(container);
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  uninstallFakeCanvas2D();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ArrangementPanel", () => {
  it("pushes a grid prop change into the live view without remounting it", () => {
    const { store, commands } = project();
    const viewRef: { current: ArrangementView | null } = { current: null };
    act(() => {
      root.render(
        <ArrangementPanel
          store={store}
          commands={commands}
          grid={{ mode: "fixed", denominator: 4 }}
          viewRef={viewRef}
        />,
      );
    });
    const view = viewRef.current as KitArrangementView;
    expect(view).not.toBeNull();
    expect(view.host.grid.gridTicks()).toBe(960);

    act(() => {
      root.render(
        <ArrangementPanel
          store={store}
          commands={commands}
          grid={{ mode: "fixed", denominator: 16 }}
          viewRef={viewRef}
        />,
      );
    });
    // Same view object — the canvas editor is never torn down under the user.
    expect(viewRef.current).toBe(view);
    expect(view.host.grid.gridTicks()).toBe(240);
  });

  it("bridges onOpenClip, onSelectChannel and onSeek back to the props", () => {
    const { store, commands, clipId } = project();
    const onOpenClip = vi.fn();
    const onSelectChannel = vi.fn();
    const onSeek = vi.fn();
    const viewRef: { current: ArrangementView | null } = { current: null };
    act(() => {
      root.render(
        <ArrangementPanel
          store={store}
          commands={commands}
          onOpenClip={onOpenClip}
          onSelectChannel={onSelectChannel}
          onSeek={onSeek}
          viewRef={viewRef}
        />,
      );
    });
    const view = viewRef.current as KitArrangementView;
    view.measure();
    view.host.viewport.setSize(768, 274);

    // A double-click on the clip: SS18-M1's "open it in the piano roll".
    const y = view.host.viewport.pxPerRow / 2;
    const point = (x: number) => ({
      pointerId: 1,
      point: { xPx: x, yPx: y, tick: view.host.viewport.tAt(x), row: view.host.viewport.rowAt(y) },
      button: 0,
      buttons: 1,
      modifiers: { shift: false, alt: false, ctrl: false, meta: false, primary: false },
      clickCount: 2,
    });
    act(() => {
      view.host.gestures.pointerDown(point(10));
      view.host.gestures.pointerUp({ ...point(10), buttons: 0 });
    });
    expect(onOpenClip).toHaveBeenCalledWith(clipId);

    const header = view.element.querySelector<HTMLElement>(".fbl-arr-header");
    act(() => {
      header?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onSelectChannel).toHaveBeenCalled();

    const ruler = view.element.querySelector<HTMLElement>(".fbl-arr-ruler");
    if (ruler !== null) stubRect(ruler);
    act(() => {
      ruler?.dispatchEvent(pointerEvent("pointerdown", 192, 5));
    });
    expect(onSeek).toHaveBeenCalled();
  });
});

describe("PianoRollPanel", () => {
  it("pushes the grid override into the live view (a created note is grid-long)", () => {
    const { store, commands, clipId } = project();
    const viewRef: { current: PianoRollView | null } = { current: null };
    const render = (denominator: number) => {
      act(() => {
        root.render(
          <PianoRollPanel
            store={store}
            commands={commands}
            clipId={clipId}
            grid={{ mode: "fixed", denominator }}
            viewRef={viewRef}
          />,
        );
      });
    };
    render(4);
    const view = viewRef.current;
    expect(view).not.toBeNull();
    stubRect(view!.element);

    // Re-render with a finer grid: it must reach the MOUNTED view.
    render(16);
    expect(viewRef.current).toBe(view);

    // SS10 `Pending`: "dbl-click empty: create grid-length note".
    const y = 200;
    act(() => {
      for (let i = 0; i < 2; i += 1) {
        view!.element.dispatchEvent(pointerEvent("pointerdown", 400, y));
        view!.element.dispatchEvent(pointerEvent("pointerup", 400, y));
      }
    });
    const notes = store.getState().clips[clipId]?.notes ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.dur).toBe(240); // a 1/16 note, not the 1/4 it mounted with
  });

  it("swaps the open clip through the live view", () => {
    const { store, commands, clipId } = project();
    const viewRef: { current: PianoRollView | null } = { current: null };
    act(() => {
      root.render(
        <PianoRollPanel store={store} commands={commands} clipId={null} viewRef={viewRef} />,
      );
    });
    expect(viewRef.current?.clipId).toBeNull();
    act(() => {
      root.render(
        <PianoRollPanel store={store} commands={commands} clipId={clipId} viewRef={viewRef} />,
      );
    });
    expect(viewRef.current?.clipId).toBe(clipId);
  });
});


// SS13: "`available` is false where OPFS is missing — the app must still run,
// just without autosave." Running without autosave is fine; TELLING the user
// their work is "Saved" is not.
describe("Toolbar autosave status", () => {
  const props = (over: Partial<ToolbarProps>): ToolbarProps => ({
    song: {
      projectName: "P",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { start: 0, end: 3840, enabled: false },
      commands: projectCommands,
      dispatch: () => undefined,
    },
    audioStatus: "idle",
    audioReady: false,
    audioBooting: false,
    onBoot: () => undefined,
    transportState: "stopped",
    onPlay: () => undefined,
    onStop: () => undefined,
    canUndo: false,
    undoLabel: undefined,
    onUndo: () => undefined,
    canRedo: false,
    redoLabel: undefined,
    onRedo: () => undefined,
    tool: "select",
    onToolChange: () => undefined,
    hasOverrides: false,
    onReenableAutomation: () => undefined,
    gridSettings: { mode: "adaptive", denominator: 16, triplet: false },
    onGridChange: () => undefined,
    autosaveState: "idle",
    autosaveError: null,
    onSaveNow: () => undefined,
    onNewProject: () => undefined,
    onExport: () => undefined,
    onImportFile: () => undefined,
    onExportWav: () => undefined,
    exportingWav: false,
    ...over,
  });

  const statusText = (): string =>
    container.querySelector("[data-testid=autosave-status]")?.textContent ?? "";

  it("says Saved when a document really is persisted", () => {
    act(() => {
      root.render(<Toolbar {...props({ autosaveState: "saved" })} />);
    });
    expect(statusText()).toBe("Saved");
  });

  it("never claims Saved when there is no storage to save to", () => {
    act(() => {
      root.render(<Toolbar {...props({ autosaveState: "idle", autosaveAvailable: false })} />);
    });
    expect(statusText()).toBe("Not saved");
  });

  it("surfaces a failed write", () => {
    act(() => {
      root.render(<Toolbar {...props({ autosaveState: "error", autosaveError: "Quota" })} />);
    });
    expect(statusText()).toBe("Save failed");
  });
});
