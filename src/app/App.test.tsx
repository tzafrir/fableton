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

/** The project name is an editable field (SS8 song controls), so its value —
 *  not a label's textContent — is what the shell renders. Queried off the
 *  document because each describe block owns its own mount container. */
function projectNameValue(): string {
  const input = document.querySelector<HTMLInputElement>("[data-testid=project-name-input]");
  if (input === null) throw new Error("project name input not rendered");
  return input.value;
}


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


/** Finds a button by its ACCESSIBLE NAME, not its text: the transport's
 *  three verbs are glyphs (▶ ■ ●) carrying `aria-label`, which is the name
 *  every other caller — the e2e suite included — already addresses them by. */
function findButton(root: ParentNode, name: string): HTMLButtonElement {
  return [...root.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  ) as HTMLButtonElement;
}

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
    expect(projectNameValue()).toBe("Demo Phrase");
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

    const boot = findButton(container, "Boot audio");
    expect(boot.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(
      () => container.querySelector("[data-testid=audio-status]")!.textContent!.startsWith("ready"),
    );

    const play = findButton(container, "Play");
    const stop = findButton(container, "Stop");
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

    const boot = findButton(container, "Boot audio");
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
    const play = findButton(container, "Play");
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
      findButton(container, "Stop").dispatchEvent(
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

  it("reports a failed device mount and keeps the app usable (SS3/SS6)", async () => {
    // The instrument's `prepare()` is `audioWorklet.addModule`: the one part
    // of a mount that talks to the network and can genuinely fail.
    const base = createFakeAudioContext();
    let failNextModule = true;
    base.audioWorklet.addModule = (url: string): Promise<void> => {
      if (failNextModule) {
        failNextModule = false;
        return Promise.reject(new Error("module load failed"));
      }
      base.addedModules.push(url);
      return Promise.resolve();
    };
    bootAudioContext.mockResolvedValue(base as unknown as BaseAudioContext);

    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();
    const boot = findButton(container, "Boot audio");
    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushMicrotasks();

    // The failure is REPORTED (the apply queue swallows nothing)...
    expect(container.querySelector("[data-testid=toolbar-status-message]")!.textContent).toContain(
      "Audio update failed",
    );
    // ...and the engine still follows the document: the next edit reconciles,
    // which is what makes the retry `prepareDefinition` allows reachable. A
    // poisoned queue left the app showing edits that never reached audio.
    const commands = createProjectCommands();
    posted.length = 0;
    const doc = store!.getState();
    const clipId = Object.keys(doc.clips)[0]!;
    await act(async () => {
      store!.dispatch(commands.addNotes(clipId, [{ start: 0, dur: 240, pitch: 41, vel: 100 }]));
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await act(async () => {
      findButton(container, "Play").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(posted.some((m) => m.type === "noteOn" && m.pitch === 41)).toBe(true);
  });

  it("stays bootable after a failed boot (the engine ref is published on success only)", async () => {
    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();
    const boot = findButton(container, "Boot audio");

    bootAudioContext.mockRejectedValueOnce(new Error("context refused"));
    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushMicrotasks();
    expect(container.querySelector("[data-testid=audio-status]")!.textContent).toContain("failed");

    // The retry must actually reach `bootAudioContext` again: a failed boot
    // that left `engineRef` set would be turned away by the re-entrancy guard
    // for the rest of the session, with only a page reload as the way out.
    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(
      () => container.querySelector("[data-testid=audio-status]")!.textContent!.startsWith("ready"),
    );
    expect(bootAudioContext).toHaveBeenCalledTimes(2);
  });

  it("clicking a track's arrangement header selects that channel for the mixer (SS3/SS15)", async () => {
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();

    const commands = createProjectCommands();
    await act(async () => {
      store!.dispatch(commands.addTrack());
    });
    const doc = store!.getState();
    const tracks = doc.channelOrder.filter((id) => doc.channels[id]?.role === "track");
    expect(tracks.length).toBeGreaterThan(1);
    const second = tracks[1]!;

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=tab-mixer]")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    const header = container.querySelector<HTMLElement>(`.fbl-arr-header[data-channel-id="${second}"]`);
    expect(header).not.toBeNull();
    await act(async () => {
      header!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    // The arrangement header paints its own highlight, so a selection it does
    // not report leaves the mixer's Group/Delete buttons, the device chain and
    // the automation menu acting on a DIFFERENT channel than the highlighted
    // one — "Delete" would delete the track the user is not looking at.
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=delete-channel-button]")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(store!.getState().channels[second]).toBeUndefined();
    expect(store!.getState().channels[tracks[0]!]).toBeDefined();
  });

  // SS5's control context menu row, end to end: it is the only path from a
  // knob to "automate THIS", and until the shell handed the controls an
  // `onShowAutomation` it did not render at all.
  it("'Show automation lane' on a mixer fader creates the lane and reveals it (SS5/SS11)", async () => {
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();

    const boot = findButton(container, "Boot audio");
    await act(async () => {
      boot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(
      () => container.querySelector("[data-testid=audio-status]")!.textContent!.startsWith("ready"),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=tab-mixer]")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    const doc = store!.getState();
    const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
    const volumeParam = doc.channels[track]!.volume;
    expect(Object.values(store!.getState().lanes)).toHaveLength(0);

    // The fader only exists once its handle registered (the reconciler syncs
    // mixer params after the mount) — that wait is the panel's own test.
    await waitFor(() => container.querySelector(`[data-testid=vol-${track}]`) !== null);
    const fader = container.querySelector<HTMLElement>(`[data-testid=vol-${track}]`)!;
    await act(async () => {
      fader.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    const row = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Show automation lane",
    );
    expect(row, "SS5's context menu must offer the automation row").toBeDefined();

    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // A lane for that exact param, and the automation tab showing it.
    const lanes = Object.values(store!.getState().lanes);
    expect(lanes.map((lane) => lane.paramId)).toEqual([volumeParam]);
    expect(lanes[0]!.enabled).toBe(true);
    expect(container.querySelector("[data-testid=automation-panel]")).not.toBeNull();
    expect(container.querySelector(`[data-testid=lane-row-${lanes[0]!.id}]`)).not.toBeNull();
  });

  it("disposes the autosave on unmount (SS13)", async () => {
    // Only `setTimeout` is faked: React's own scheduling must keep running.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let store: DocumentStore | undefined;
      await act(async () => {
        root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
      });
      await flushMicrotasks();
      const write = vi.spyOn(storage, "write");
      const commands = createProjectCommands();

      // Positive control: while mounted, an edit debounces into a write.
      await act(async () => {
        store!.dispatch(commands.renameProject("While Mounted"));
      });
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await flushMicrotasks();
      expect(write).toHaveBeenCalled();

      write.mockClear();
      act(() => {
        root.unmount();
      });

      // The unmount cleanup used to read the FIRST render's `docState`
      // (always null with `[]` deps), so the autosave kept its `onChange`
      // subscription and its pending timer, and an orphaned write could land
      // on the slot a remounted app had already written.
      await act(async () => {
        store!.dispatch(commands.renameProject("After Unmount"));
      });
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await flushMicrotasks();
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("boots once even when clicked twice in the same frame", async () => {
    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();
    const boot = findButton(container, "Boot audio");
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
    expect(projectNameValue()).toBe("Renamed");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });

    expect(store.getState().name).not.toBe("Renamed");
    expect(projectNameValue()).not.toBe("Renamed");
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
    return findButton(container, text);
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

    expect(projectNameValue()).toBe("Imported Project");
  });

  // SS10 "Snapping": "Grid is adaptive to zoom (as in Live) with a fixed-grid
  // override menu and a triplet toggle." Both live in the toolbar (the app's
  // only chrome) and both must reach the mounted editors — the create-time
  // `grid` option alone leaves them unreachable at runtime.
  it("exposes the grid override menu and the triplet toggle", async () => {
    const storage = createMemoryProjectStorage();
    await act(async () => {
      root.render(<App storage={storage} />);
    });
    await flushMicrotasks();

    const select = container.querySelector<HTMLSelectElement>("[data-testid=grid-select]")!;
    expect(select).not.toBeNull();
    expect([...select.options].map((option) => option.value)).toEqual([
      "adaptive",
      "4",
      "8",
      "16",
      "32",
      "off",
    ]);
    expect(select.value).toBe("adaptive");

    await act(async () => {
      select.value = "8";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector<HTMLSelectElement>("[data-testid=grid-select]")!.value).toBe("8");

    const triplet = container.querySelector<HTMLInputElement>("[data-testid=grid-triplet-toggle]")!;
    expect(triplet.checked).toBe(false);
    // A CLICK, not a synthetic `change`: React drives `onChange` for
    // checkboxes off the click event, so dispatching `change` by hand never
    // runs the handler — and React restores a controlled checkbox whose value
    // its state did not agree with, so this assertion fails if the toolbar's
    // `onGridChange` is not wired.
    await act(async () => {
      triplet.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector<HTMLInputElement>("[data-testid=grid-triplet-toggle]")!.checked).toBe(true);
    // Still "1/8" — the two controls are independent (mode vs triplet).
    expect(container.querySelector<HTMLSelectElement>("[data-testid=grid-select]")!.value).toBe("8");
  });

  // SS13: the pending ~2 s debounce still holds the open project's edits, and
  // `replaceDocument` clears the store's dirty flag — so New/Import have to
  // flush first or every edit inside the window is silently destroyed (on a
  // first run, the whole project).
  it("New flushes the outgoing project's pending autosave first", async () => {
    const storage = createMemoryProjectStorage();
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();
    const outgoingId = store!.getState().id;
    const commands = createProjectCommands();
    await act(async () => {
      store!.dispatch(commands.renameProject("EDITED, NEVER SAVED"));
    });
    // No debounce has fired yet: the edit exists only in memory.
    expect(await storage.read(outgoingId)).toBeNull();

    await act(async () => {
      button("New").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushMicrotasks();

    const saved = await storage.read(outgoingId);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).project.name).toBe("EDITED, NEVER SAVED");
    expect(projectNameValue()).toBe("Untitled");
  });

  it("Import flushes the outgoing project's pending autosave first", async () => {
    const storage = createMemoryProjectStorage();
    let store: DocumentStore | undefined;
    await act(async () => {
      root.render(<App storage={storage} onStoreReady={(s) => (store = s)} />);
    });
    await flushMicrotasks();
    const outgoingId = store!.getState().id;
    const commands = createProjectCommands();
    await act(async () => {
      store!.dispatch(commands.renameProject("EDITED, NEVER SAVED"));
    });

    const incoming = createEmptyProject({ ids: createSequentialIdFactory("other"), name: "Imported Project" });
    const file = new File([projectCodec.encode(incoming)], "incoming.json", {
      type: "application/json",
    });
    const input = container.querySelector<HTMLInputElement>("[data-testid=import-file-input]")!;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const saved = await storage.read(outgoingId);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).project.name).toBe("EDITED, NEVER SAVED");
    expect(projectNameValue()).toBe("Imported Project");
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
    expect(projectNameValue()).toBe("Renamed");

    await act(async () => {
      button("New").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(projectNameValue()).toBe("Untitled");
    expect(store!.canUndo()).toBe(false);
  });
});
