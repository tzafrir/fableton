// SS11 — the automation lane editor: the canvas kit's THIRD skin.
//
// "Editing reuses the kit verbatim: click a segment to add a point, drag a
// point (snap on time axis only), drag a segment's middle to bend `curve`,
// marquee + the same keyboard nudges." One lane at a time is shown; the
// panel around it picks which (SS18-M3 note: the plan draws lanes as
// expandable rows inside the arrangement, but M1 froze the arrangement's
// row convention as `row = index in channelOrder`, so the lane editor lives
// in its own panel — same kit, same verbs, different placement. Recorded as
// a deliberate deviation.)
//
// Points carry no ids: gestures key them by their tick at gesture start,
// which is exactly what the SS11 lane commands take.
//
// This file is only the WIRING. The scene is in `layers.ts` and the verbs in
// `hits.ts` / `handlers.ts` / `keymap.ts`, all written against the
// `context.ts` object — so every one of them runs headless under Vitest
// (SS15), the same split the piano roll uses.

import type {
  AutoPoint,
  DocumentStore,
  GridSettings,
  LaneId,
  ParamDescriptor,
  ProjectCommands,
  Ticks,
  Unsub,
} from "../../types";
import { createEditorHost, type KitEditorHost } from "../kit/host";
import { createTickSelection, type AutomationLaneContext, type TickSelection } from "./context";
import { createAutomationDragHandlers, type LanePreview } from "./handlers";
import { createAutomationHitTester, type LaneHit } from "./hits";
import { createAutomationKeyBinding } from "./keymap";
import {
  createAutomationContentLayer,
  createAutomationGridLayer,
  createAutomationOverlayLayer,
} from "./layers";

export interface AutomationLaneViewOptions {
  container: HTMLElement;
  store: DocumentStore;
  commands: ProjectCommands;
  grid?: Partial<GridSettings> | undefined;
  dpr?: number | undefined;
}

export interface AutomationLaneView {
  readonly element: HTMLElement;
  /** Which lane is shown; `desc` maps the value axis (null = greyed lane). */
  setLane(laneId: LaneId | null, desc: ParamDescriptor | null): void;
  /** SS10's grid override menu, same pass-through as the piano roll's. */
  setGrid(settings: Partial<GridSettings>): void;
  setPlayheadTicks(tick: Ticks): void;
  focus(): void;
  dispose(): void;
}

export function createAutomationLaneView(options: AutomationLaneViewOptions): AutomationLaneView {
  const { store } = options;

  // --- mutable editor state (never document state, SS13) --------------------
  let laneId: LaneId | null = null;
  let desc: ParamDescriptor | null = null;

  const selection: TickSelection = createTickSelection(() => {
    host.renderer.invalidate("overlay");
  });

  const ctx: AutomationLaneContext = {
    commands: options.commands,
    selection,
    // Getters: the host does not exist yet here, and both are stable once it
    // does — nothing reads them before the first event or frame.
    get viewport() {
      return host.viewport;
    },
    get grid() {
      return host.grid;
    },
    laneId: () => laneId,
    desc: () => desc,
    points: () => {
      if (laneId === null) return [];
      return (store.getState().lanes[laneId]?.points ?? []) as readonly AutoPoint[];
    },
    // Straight from the renderer, so the value axis is right on the very
    // first hit-test — before any layer has drawn — and after every resize.
    heightPx: () => host.renderer.heightPx,
  };

  const host: KitEditorHost<LaneHit> = createEditorHost<LaneHit>({
    container: options.container,
    store: options.store,
    layers: [
      createAutomationGridLayer(ctx),
      createAutomationContentLayer(ctx),
      createAutomationOverlayLayer(ctx, () => host.gestures.preview as LanePreview | null),
    ],
    viewport: { pxPerTick: 0.05, pxPerRow: 16 },
    grid: options.grid,
    hitTesters: [createAutomationHitTester(ctx)],
    dragHandlers: createAutomationDragHandlers(ctx),
    keyBindings: [createAutomationKeyBinding(ctx)],
    dpr: options.dpr,
  });

  // Repaint on document change (the lane's points may have moved).
  const unsubStore: Unsub = store.onChange(() => {
    host.renderer.invalidate(["content", "overlay"]);
  });

  return {
    element: host.element,
    setLane(nextLaneId: LaneId | null, nextDesc: ParamDescriptor | null): void {
      laneId = nextLaneId;
      desc = nextDesc;
      selection.clear();
      host.renderer.invalidateAll();
    },
    setGrid(settings: Partial<GridSettings>): void {
      // The host's `Grid` re-notifies (and the host invalidates grid +
      // content) only when the division actually changes, so this is a
      // pass-through — exactly as in `pianoRoll.ts`.
      host.grid.setSettings(settings);
    },
    setPlayheadTicks(tick: Ticks): void {
      host.playhead.setTicks(tick);
    },
    focus(): void {
      host.focus();
    },
    dispose(): void {
      unsubStore();
      host.dispose();
    },
  };
}
