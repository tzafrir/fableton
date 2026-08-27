// The shipped M1 app shell's own seam tests (SS15: "no browser needed for
// any of the load-bearing logic"). jsdom has no Web Audio and no
// `getContext('2d')`, so `bootAudioContext` is mocked (same pattern M0's
// App.test.tsx used) and the canvas editors run over the kit's fake 2D
// context (`installFakeCanvas2D`, the same double `arrangement.test.ts` and
// `pianoRoll.test.ts` use).
//
// What this file owns: the WIRING SS18-M1 asks the app shell for — global
// undo/redo reaching the real store, the transport bar driving a real (fake
// Web-Audio-backed) engine, and save/export/import hitting the persistence
// package — not the editors' own gesture/rendering behavior, which is each
// editor package's own test suite.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeAudioNode,
  FakeAudioParam,
  createFakeAudioContext,
} from "../devices/harness/testing/fakeAudio";
import { installFakeCanvas2D, uninstallFakeCanvas2D } from "../editor/kit/testing/fakeCanvas";
import { createMemoryProjectStorage, projectCodec } from "../persist";
import { createEmptyProject, createProjectCommands, createSequentialIdFactory } from "../state";
import type { DocumentStore, Project, ProjectStorage } from "../types";
import { App } from "./App";

const bootAudioContext = vi.fn();

vi.mock("../engine/context", () => ({
  bootAudioContext: (...args: unknown[]) => bootAudioContext(...args) as unknown,
}));

const downloadProjectFile = vi.fn();

vi.mock("../persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persist")>();
  return {
    ...actual,
    downloadProjectFile: (...args: unknown[]) => downloadProjectFile(...args) as unknown,
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** A k-rate `AudioParam` that vivifies on first read, mirroring the real
 *  `AudioWorkletNode.parameters` map (the same stub `demo/engine.test.ts` and
 *  `app/engine/projectEngine.test.ts` use). */
class VivifyingParamMap extends Map<string, FakeAudioParam> {
  override get(name: string): FakeAudioParam {
    let param = super.get(name);
    if (param === undefined) {
      param = new FakeAudioParam(name, 0);
      this.set(name, param);
    }
    return param;
  }
}

interface PostedMessage {
  readonly type?: string;
  readonly pitch?: number;
  readonly when?: number;
}

/** Everything every stub worklet has been told to play since the last
 *  `posted.length = 0` — the observation point for "did this edit actually
 *  reach an instrument", same trick `app/engine/projectEngine.test.ts` uses.
 *
 *  CLONED, never retained by reference: `core.poly-synth` reuses one
 *  preallocated message object per method (SS12's "zero allocation in
 *  per-tick paths"), so pushing the argument itself would make every entry
 *  alias the last event posted. */
const posted: PostedMessage[] = [];

class StubAudioWorkletNode extends FakeAudioNode {
  readonly parameters = new VivifyingParamMap();
  readonly port = {
    postMessage: (message: unknown): void => {
      posted.push(structuredClone(message) as PostedMessage);
    },
  };
  constructor(_ctx: unknown, _processorName: string) {
    super("audio-worklet");
  }
}

function flushMicrotasks(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  if (!predicate()) throw new Error("waitFor: condition never became true");
}

describe("App (SS18-M1 app shell)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let storage: ProjectStorage;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installFakeCanvas2D();
    posted.length = 0;
    vi.stubGlobal("AudioWorkletNode", StubAudioWorkletNode);
    storage = createMemoryProjectStorage();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const base = createFakeAudioContext();
    bootAudioContext.mockResolvedValue(base as unknown as BaseAudioContext);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    uninstallFakeCanvas2D();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders a loading placeholder, then the app shell once the project is ready", async () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Fableton");

    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();

    expect(container.querySelector("[data-testid=toolbar]")).not.toBeNull();
    expect(container.querySelector("[data-testid=arrangement-panel]")).not.toBeNull();
    expect(container.querySelector("[data-testid=piano-roll-panel]")).not.toBeNull();
    // A first run opens the starter project (src/demo/project.ts), not an
    // empty document — see `bootstrapProject`'s `createProject` default.
    expect(container.querySelector("[data-testid=project-name]")!.textContent).toBe("Demo Phrase");
  });

  it("mounts the arrangement's three SS9 canvas layers", async () => {
    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();

    const panel = container.querySelector("[data-testid=arrangement-panel]")!;
    const canvases = [...panel.querySelectorAll("canvas")];
    const classNames = canvases.map((c) => c.className);
    for (const kind of ["grid", "content", "overlay"]) {
      expect(classNames.some((name) => name.includes(`fbl-layer-${kind}`))).toBe(true);
    }
  });

  it("Boot audio enables Play/Stop and reflects transport state", async () => {
    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();

    const boot = [...container.querySelectorAll("button")].find((b) => b.textContent === "Boot audio")!;
    expect(boot.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(
      () => container.querySelector("[data-testid=audio-status]")!.textContent!.startsWith("ready"),
    );

    const play = [...container.querySelectorAll("button")].find((b) => b.textContent === "Play")!;
    const stop = [...container.querySelectorAll("button")].find((b) => b.textContent === "Stop")!;
    expect(play.hasAttribute("disabled")).toBe(false);
    expect(stop.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      play.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid=transport-state]")!.textContent).toBe("playing");

    await act(async () => {
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid=transport-state]")!.textContent).toBe("stopped");
  });

  // THE M1 INTEGRATION CLAIM, end to end in one test (SS3: "the document is
  // the source of truth"; SS12: the scheduler walks the document's clips).
  // Every other test here checks one seam; this one checks that the seams are
  // actually joined: a command dispatched on the bus mutates the document,
  // the document change reaches `ProjectEngine.applyDocument`, that re-points
  // the transport's event source, and pressing Play hands the resulting note
  // to a real mounted instrument. Nothing in this chain is hard-coded any
  // more — before the M1 migration the transport read a `MidiClip` constant.
  it("an edit dispatched on the command bus becomes scheduled audio", async () => {
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();

    const boot = [...container.querySelectorAll("button")].find((b) => b.textContent === "Boot audio")!;
    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(
      () => container.querySelector("[data-testid=audio-status]")!.textContent!.startsWith("ready"),
    );

    // A pitch nothing in the starter document plays, so a noteOn carrying it
    // can only have come from the command dispatched below.
    const UNIQUE_PITCH = 42;
    const doc = store!.getState();
    const clipId = Object.keys(doc.clips)[0]!;
    expect(doc.clips[clipId]!.notes.some((n) => n.pitch === UNIQUE_PITCH)).toBe(false);

    const commands = createProjectCommands();
    await act(async () => {
      store!.dispatch(
        commands.addNotes(clipId, [{ start: 0, dur: 240, pitch: UNIQUE_PITCH, vel: 100 }]),
      );
    });
    // `applyDocument` is queued behind an async mount, so let it settle
    // before asking the transport to schedule anything.
    await flushMicrotasks();
    await flushMicrotasks();

    posted.length = 0;
    const play = [...container.querySelectorAll("button")].find((b) => b.textContent === "Play")!;
    await act(async () => {
      play.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // `play()` fills the first look-ahead window synchronously (SS12), so the
    // note at tick 0 is already scheduled by the time the click returns.
    expect(
      posted.some((m) => m.type === "noteOn" && m.pitch === UNIQUE_PITCH),
      `no noteOn for the note just added; posted=${JSON.stringify(posted)}`,
    ).toBe(true);

    // ...and undo is audible in the same way: the note stops being scheduled.
    await act(async () => {
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Stop")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await act(async () => {
      store!.undo();
    });
    await flushMicrotasks();
    await flushMicrotasks();

    posted.length = 0;
    await act(async () => {
      play.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(posted.some((m) => m.type === "noteOn" && m.pitch === UNIQUE_PITCH)).toBe(false);
  });

  it("boots once even when clicked twice in the same frame", async () => {
    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();
    const boot = [...container.querySelectorAll("button")].find((b) => b.textContent === "Boot audio")!;
    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(bootAudioContext).toHaveBeenCalledTimes(1);
  });
});

describe("App — global undo/redo (SS18-M1: Cmd/Ctrl+Z / Shift+Z)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installFakeCanvas2D();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    uninstallFakeCanvas2D();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function mountWithStore(): Promise<DocumentStore> {
    const storage = createMemoryProjectStorage();
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();
    if (store === undefined) throw new Error("onStoreReady never fired");
    return store;
  }

  it("Ctrl+Z on the window undoes the last dispatched command", async () => {
    const store = await mountWithStore();
    const commands = createProjectCommands();
    await act(async () => {
      store.dispatch(commands.renameProject("Renamed"));
    });
    expect(store.getState().name).toBe("Renamed");
    expect(container.querySelector("[data-testid=project-name]")!.textContent).toBe("Renamed");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });

    expect(store.getState().name).not.toBe("Renamed");
    expect(container.querySelector("[data-testid=project-name]")!.textContent).not.toBe("Renamed");
  });

  it("Ctrl+Shift+Z redoes", async () => {
    const store = await mountWithStore();
    const commands = createProjectCommands();
    await act(async () => {
      store.dispatch(commands.renameProject("Renamed"));
      store.undo();
    });
    expect(store.getState().name).not.toBe("Renamed");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(store.getState().name).toBe("Renamed");
  });

  it("the toolbar's Undo/Redo buttons drive the same store", async () => {
    const store = await mountWithStore();
    const commands = createProjectCommands();

    const undoButton = () => container.querySelector<HTMLButtonElement>("[data-testid=undo-button]")!;
    const redoButton = () => container.querySelector<HTMLButtonElement>("[data-testid=redo-button]")!;
    expect(undoButton().disabled).toBe(true);

    await act(async () => {
      store.dispatch(commands.renameProject("Renamed"));
    });
    expect(undoButton().disabled).toBe(false);

    await act(async () => {
      undoButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(store.getState().name).not.toBe("Renamed");
    expect(redoButton().disabled).toBe(false);

    await act(async () => {
      redoButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(store.getState().name).toBe("Renamed");
  });

  it("backs off while a text field has focus (does not fight native field undo)", async () => {
    const store = await mountWithStore();
    const commands = createProjectCommands();
    await act(async () => {
      store.dispatch(commands.renameProject("Renamed"));
    });

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    try {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
      });
      expect(store.getState().name).toBe("Renamed");
    } finally {
      input.remove();
    }
  });
});

describe("App — save / export / import (SS13 via the persistence package)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installFakeCanvas2D();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    uninstallFakeCanvas2D();
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  function button(text: string): HTMLButtonElement {
    return [...container.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
  }

  it("Save flushes a pending autosave write to storage", async () => {
    const storage = createMemoryProjectStorage();
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();
    const commands = createProjectCommands();
    await act(async () => {
      store!.dispatch(commands.renameProject("Saved Name"));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=save-button]")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushMicrotasks();

    const key = store!.getState().id;
    const saved = await storage.read(key);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).project.name).toBe("Saved Name");
    expect(container.querySelector("[data-testid=autosave-status]")!.textContent).toBe("Saved");
  });

  it("Export flushes first, then downloads the current project", async () => {
    const storage = createMemoryProjectStorage();
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=export-button]")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushMicrotasks();

    expect(downloadProjectFile).toHaveBeenCalledTimes(1);
    const [, exported] = downloadProjectFile.mock.calls[0] as [unknown, Project];
    expect(exported.id).toBe(store!.getState().id);
  });

  it("Import replaces the document with the chosen file's project", async () => {
    const storage = createMemoryProjectStorage();
    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();

    const incoming = createEmptyProject({ ids: createSequentialIdFactory("other"), name: "Imported Project" });
    const text = projectCodec.encode(incoming);
    const file = new File([text], "incoming.json", { type: "application/json" });

    const input = container.querySelector<HTMLInputElement>("[data-testid=import-file-input]")!;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushMicrotasks();

    expect(container.querySelector("[data-testid=project-name]")!.textContent).toBe("Imported Project");
  });

  it("New starts a fresh empty project", async () => {
    const storage = createMemoryProjectStorage();
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();
    const commands = createProjectCommands();
    await act(async () => {
      store!.dispatch(commands.renameProject("Renamed"));
    });
    expect(container.querySelector("[data-testid=project-name]")!.textContent).toBe("Renamed");

    await act(async () => {
      button("New").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid=project-name]")!.textContent).toBe("Untitled");
    expect(store!.canUndo()).toBe(false);
  });
});
