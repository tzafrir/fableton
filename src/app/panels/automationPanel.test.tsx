// SS11/SS18-M3 — the automation panel's React side, tested at the seam the
// panel actually owns: what it pushes into the canvas lane editor and when.
//
// The lane editor itself is mocked here. That is deliberate: its gestures and
// rendering are `src/editor/automation`'s own suite, and what went wrong in
// this panel was purely a dependency-array question — HOW OFTEN `setLane` is
// called — which is only observable with a view double.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createParamRegistry, p, volumeParamId, withParamId } from "../../params";
import { createDocumentStore, createEmptyProject, createProjectCommands, createSequentialIdFactory } from "../../state";
import type { AppParamRegistry } from "../../params";
import type { AutomationLane, ChannelId, DocumentStore, ProjectCommands } from "../../types";
import type { AppProjectEngine } from "../engine";
import { AutomationPanel } from "./AutomationPanel";

const setLane = vi.fn();
const setGrid = vi.fn();
const created = vi.fn();

vi.mock("../../editor/automation/view", () => ({
  createAutomationLaneView: (options: { grid?: unknown }) => {
    created(options.grid);
    return {
      element: document.createElement("div"),
      setLane: (...args: unknown[]) => setLane(...args),
      setGrid: (...args: unknown[]) => setGrid(...args),
      setPlayheadTicks: () => undefined,
      focus: () => undefined,
      dispose: () => undefined,
    };
  },
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

function stubEngine(params: AppParamRegistry): AppProjectEngine {
  return {
    params,
    transport: { positionTicks: () => 0 },
  } as unknown as AppProjectEngine;
}

/** A project with one automation lane on the track's mixer volume. */
function project(): {
  store: DocumentStore;
  commands: ProjectCommands;
  track: ChannelId;
  laneId: string;
} {
  const ids = createSequentialIdFactory("a");
  const commands = createProjectCommands(ids);
  const doc = createEmptyProject({ ids, name: "Lanes" });
  const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
  const lane: AutomationLane = {
    id: "lane1",
    channelId: track,
    paramId: volumeParamId(track),
    points: [{ t: 0, v: 0, curve: 0 }],
    enabled: true,
  };
  doc.lanes[lane.id] = lane;
  return { store: createDocumentStore(doc, { now: () => 0 }), commands, track, laneId: lane.id };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setLane.mockClear();
  setGrid.mockClear();
  created.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("AutomationPanel — pushing the lane into the editor", () => {
  it("does not re-push (and so does not clear the selection) on an unrelated edit", () => {
    const { store, commands, track, laneId } = project();
    const params = createParamRegistry();
    params.register(withParamId(p.db("vol", "Volume", { min: -60, max: 6, default: 0 }), volumeParamId(track)));
    const engine = stubEngine(params);

    act(() => {
      root.render(
        <AutomationPanel store={store} commands={commands} engine={engine} channelId={track} />,
      );
    });
    expect(setLane).toHaveBeenCalledTimes(1);
    expect(setLane).toHaveBeenLastCalledWith(laneId, expect.objectContaining({ id: volumeParamId(track) }));

    // Any document change at all — here the lane editor's own kind of edit.
    act(() => {
      store.dispatch(commands.addLanePoint(laneId, { t: 480, v: -6, curve: 0 }));
    });

    // `setLane` unconditionally resets the editor's point selection and
    // invalidates all three layers, so re-pushing per document change made
    // repeated arrow-key nudges (SS11 "marquee + the same keyboard nudges")
    // impossible: the first nudge dispatched, the selection vanished, the
    // second acted on nothing.
    expect(setLane).toHaveBeenCalledTimes(1);
    params.dispose();
  });

  // SS10's grid override menu / triplet toggle is the toolbar's, and it has to
  // reach the third kit skin as it reaches the other two — through `setGrid`,
  // not by re-creating the view (which would drop the viewport and the point
  // selection mid-edit).
  it("pushes a toolbar grid change into the editor instead of re-creating it", () => {
    const { store, commands, track } = project();
    const params = createParamRegistry();
    const engine = stubEngine(params);
    const render = (grid: { denominator: number }): void => {
      act(() => {
        root.render(
          <AutomationPanel
            store={store}
            commands={commands}
            engine={engine}
            channelId={track}
            grid={grid}
          />,
        );
      });
    };

    render({ denominator: 16 });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenLastCalledWith({ denominator: 16 });

    render({ denominator: 4 });
    expect(setGrid).toHaveBeenLastCalledWith({ denominator: 4 });
    expect(created).toHaveBeenCalledTimes(1); // same view, new grid
    params.dispose();
  });

  it("re-pushes when the selected lane's descriptor arrives from the registry", () => {
    const { store, commands, track, laneId } = project();
    const params = createParamRegistry();
    const engine = stubEngine(params);

    act(() => {
      root.render(
        <AutomationPanel store={store} commands={commands} engine={engine} channelId={track} />,
      );
    });
    // No handle yet: the lane is the SS7 "kept, greyed" case.
    expect(setLane).toHaveBeenLastCalledWith(laneId, null);

    // Registration happens asynchronously (the reconciler mounts, then syncs
    // mixer params) — long after React flushed this document's render.
    act(() => {
      params.register(withParamId(p.db("vol", "Volume", { min: -60, max: 6, default: 0 }), volumeParamId(track)));
    });
    expect(setLane).toHaveBeenLastCalledWith(laneId, expect.objectContaining({ id: volumeParamId(track) }));
    params.dispose();
  });

  it("fills the SS11 add-lane menu when params register after the render", () => {
    const { store, commands, track } = project();
    const params = createParamRegistry();
    const engine = stubEngine(params);

    act(() => {
      root.render(
        <AutomationPanel store={store} commands={commands} engine={engine} channelId={track} />,
      );
    });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="add-lane-select"]')!;
    expect(select.options).toHaveLength(1); // the placeholder only

    act(() => {
      params.register(withParamId(p.db("vol", "Volume", { min: -60, max: 6, default: 0 }), volumeParamId(track)));
    });
    expect([...select.options].map((o) => o.value)).toContain(volumeParamId(track));
    params.dispose();
  });
});
