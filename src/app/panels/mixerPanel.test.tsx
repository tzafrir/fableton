// SS6/SS18-M2 — the mixer strip's two non-obvious seams:
//
//  1. param handles appear ASYNCHRONOUSLY (the reconciler registers them after
//     `await applyPatch`), so the strip has to follow the registry, not just
//     the document; and
//  2. "cycle-forming edits are rejected with an inline hint" (SS6) — a
//     rejection emits nothing to store subscribers, so the panel itself has to
//     render the reason AND snap the controlled `<select>` back.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createParamRegistry, p, volumeParamId, withParamId } from "../../params";
import { createDocumentStore, createEmptyProject, createProjectCommands, createSequentialIdFactory } from "../../state";
import type { AppParamRegistry } from "../../params";
import type { ChannelId, DocumentStore, ProjectCommands } from "../../types";
import type { AppProjectEngine } from "../engine";
import { MixerPanel } from "./MixerPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

function stubEngine(params: AppParamRegistry): AppProjectEngine {
  return {
    params,
    meters: { frame: () => undefined },
  } as unknown as AppProjectEngine;
}

function project(): { store: DocumentStore; commands: ProjectCommands; track: ChannelId } {
  const ids = createSequentialIdFactory("m");
  const commands = createProjectCommands(ids);
  const doc = createEmptyProject({ ids, name: "Mix" });
  const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
  return { store: createDocumentStore(doc, { now: () => 0 }), commands, track };
}

/** Runs `dispatch` and returns the channel id it created (group ids are
 *  minted inside the command, so the caller learns them from the diff). */
function newChannel(store: DocumentStore, run: () => void): ChannelId {
  const before = new Set(store.getState().channelOrder);
  run();
  const created = store.getState().channelOrder.find((id) => !before.has(id));
  if (created === undefined) throw new Error("no channel was created");
  return created;
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("MixerPanel", () => {
  it("shows the fader as soon as its param registers, with no document change", () => {
    const { store, commands, track } = project();
    const params = createParamRegistry();
    const engine = stubEngine(params);

    act(() => {
      root.render(
        <MixerPanel
          store={store}
          commands={commands}
          engine={engine}
          selectedChannelId={track}
          onSelectChannel={() => undefined}
        />,
      );
    });
    // The `—` placeholder: audio is up but this channel's handle is not
    // registered yet.
    expect(container.querySelector(`[data-testid="vol-${track}"]`)).toBeNull();

    act(() => {
      params.register(withParamId(p.db("vol", "Volume", { min: -60, max: 6, default: 0 }), volumeParamId(track)));
    });
    // Nothing dispatched a command — only the registry changed.
    expect(container.querySelector(`[data-testid="vol-${track}"]`)).not.toBeNull();
    params.dispose();
  });

  it("explains a rejected routing change and snaps the select back (SS6)", () => {
    const { store, commands, track } = project();
    const params = createParamRegistry();

    // Two groups, the first already feeding the second.
    let g1 = "";
    let g2 = "";
    act(() => {
      g1 = newChannel(store, () => store.dispatch(commands.addGroup([track])));
    });
    act(() => {
      g2 = newChannel(store, () => store.dispatch(commands.addGroup([g1])));
    });
    expect(store.getState().channels[g1]?.output).toBe(g2);

    act(() => {
      root.render(
        <MixerPanel
          store={store}
          commands={commands}
          engine={stubEngine(params)}
          selectedChannelId={track}
          onSelectChannel={() => undefined}
        />,
      );
    });

    const select = container.querySelector<HTMLSelectElement>(`[data-testid="output-${g2}"]`)!;
    const before = select.value;
    // g2 -> g1 closes the loop g1 -> g2 -> g1: the SS6 DFS check rejects it.
    act(() => {
      select.value = g1;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const hint = container.querySelector('[data-testid="mixer-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent ?? "").not.toHaveLength(0);
    // The document is untouched, and the control now agrees with it again —
    // without the forced re-render the `<select>` kept displaying `g1`.
    expect(store.getState().channels[g2]?.output).toBe(before);
    expect(select.value).toBe(before);
    params.dispose();
  });

  // The mixer and the device chain are separate full-width views now, so the
  // strip carries the bridge between them — and, because it has to say
  // something, it says how much is mounted on the channel.
  describe("the strip's device button", () => {
    it("counts what is on the channel and opens it", () => {
      const { store, commands, track } = project();
      const opened: string[] = [];
      const rendered = (): void => {
        act(() => {
          root.render(
            <MixerPanel
              store={store}
              commands={commands}
              engine={null}
              selectedChannelId={track}
              onSelectChannel={() => undefined}
              onOpenDevices={(id) => opened.push(id)}
            />,
          );
        });
      };
      rendered();

      const button = (): HTMLButtonElement =>
        container.querySelector<HTMLButtonElement>(`[data-testid="strip-devices-${track}"]`)!;
      // A fresh track has its instrument and nothing else.
      expect(button().textContent).toBe("1 device");

      act(() => {
        store.dispatch(
          commands.addEffect(track, { definitionId: "core.filter", version: 1 }),
        );
      });
      rendered();
      expect(button().textContent).toBe("2 devices");

      act(() => {
        button().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(opened).toEqual([track]);
    });

    it("is absent where there is no chain view to open", () => {
      const { store, commands, track } = project();
      act(() => {
        root.render(
          <MixerPanel
            store={store}
            commands={commands}
            engine={null}
            selectedChannelId={track}
            onSelectChannel={() => undefined}
          />,
        );
      });
      expect(container.querySelector(`[data-testid="strip-devices-${track}"]`)).toBeNull();
    });
  });
});
