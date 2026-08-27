// SS5/SS7/SS18-M4 — the device chain panel's two "nobody told React" seams:
// param handles that register after the mount that created them, and the
// preset store, which writes localStorage and notifies no one.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createParamRegistry, deviceParamId, p, qualifyDescriptor } from "../../params";
import { presetStore } from "../../presets/store";
import { createDocumentStore, createEmptyProject, createProjectCommands, createSequentialIdFactory } from "../../state";
import type { AppParamRegistry } from "../../params";
import type { ChannelId, DeviceInstanceId, DocumentStore, ProjectCommands } from "../../types";
import type { AppProjectEngine } from "../engine";
import { DeviceChainPanel } from "./DeviceChainPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PRESET_NAME = "Test Patch";

let container: HTMLDivElement;
let root: Root;

function stubEngine(params: AppParamRegistry): AppProjectEngine {
  return { params } as unknown as AppProjectEngine;
}

function project(): {
  store: DocumentStore;
  commands: ProjectCommands;
  track: ChannelId;
  deviceId: DeviceInstanceId;
} {
  const ids = createSequentialIdFactory("d");
  const commands = createProjectCommands(ids);
  const doc = createEmptyProject({ ids, name: "Chain" });
  const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
  const deviceId = doc.channels[track]!.source!.deviceId;
  return { store: createDocumentStore(doc, { now: () => 0 }), commands, track, deviceId };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  presetStore.remove("core.poly-synth", PRESET_NAME);
  vi.restoreAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("DeviceChainPanel", () => {
  it("renders a device param's control as soon as its handle registers", () => {
    const { store, commands, track, deviceId } = project();
    const params = createParamRegistry();

    act(() => {
      root.render(
        <DeviceChainPanel store={store} commands={commands} engine={stubEngine(params)} channelId={track} />,
      );
    });
    const cutoffId = deviceParamId(track, deviceId, "cutoff");
    // Before the handle exists the panel draws the dead `<span>` placeholder.
    expect(container.querySelector(`[data-testid="ctl-${cutoffId}"]`)).toBeNull();

    // `host.mount` awaits the definition's `prepare()` (SS7), so this always
    // lands after React flushed the render for the edit that added the device.
    act(() => {
      params.register(
        qualifyDescriptor(p.hz("cutoff", "Cutoff", { min: 40, max: 18000, default: 8000 }), {
          channelId: track,
          instanceId: deviceId,
        }),
      );
    });
    expect(container.querySelector(`[data-testid="ctl-${cutoffId}"]`)).not.toBeNull();
    params.dispose();
  });

  it("lists a preset in the picker immediately after saving it (SS4)", () => {
    const { store, commands, track, deviceId } = project();
    const params = createParamRegistry();
    vi.spyOn(window, "prompt").mockReturnValue(PRESET_NAME);

    act(() => {
      root.render(
        <DeviceChainPanel store={store} commands={commands} engine={stubEngine(params)} channelId={track} />,
      );
    });
    const options = (): string[] => [
      ...container.querySelectorAll<HTMLOptionElement>(`[data-testid="preset-select-${deviceId}"] option`),
    ].map((o) => o.value);
    expect(options()).not.toContain(PRESET_NAME);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(`[data-testid="preset-save-${deviceId}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // `presetStore.save` only writes localStorage — without the panel's own
    // revision bump the picker kept showing the previous set, so the user
    // could not recall the preset they had just saved.
    expect(options()).toContain(PRESET_NAME);
    params.dispose();
  });
});
