// SS9/SS18-M1 — the arrangement lanes, assembled: "one row per track; clip
// create/move/trim/split/loop as FSM verbs, each drag = ghost preview and
// exactly one command."
//
// This file is deliberately thin. Everything load-bearing lives in a pure
// module next door — geometry, the indexed scene, the verb math, the drag
// handlers, the key map — and all this does is wire them to the kit's host
// (viewport + grid + renderer + gesture engine + playhead) and to the store's
// patch stream:
//
//   store patches  -> scene.update -> invalidate ONLY the layers that changed
//   selection      -> invalidate overlay (never content: SS9's layer rules)
//   gesture commit -> exactly one command, dispatched by the kit
//   playback       -> DOM playhead + ruler readout, zero canvas invalidation

import type {
  ArrangementOptions,
  ArrangementView,
  CreateArrangement,
  SelectionModel,
} from "../../types/editor";
import type { DocumentChange, Patch, ProjectSnapshot } from "../../types/commands";
import type { ChannelId, ClipId } from "../../types/ids";
import type { EditorLayer, LayerFrame } from "../../types/render";
import type { Ticks } from "../../types/time";
import type { GridSettings } from "../../types/viewport";
import { createEditorHost, createSelectionModel, type KitEditorHost } from "../kit";
import { ticksPerBar } from "../../time";
import type { ArrangementTheme } from "./constants";
import {
  CONTENT_TAIL_BARS,
  DEFAULT_LANE_HEIGHT_PX,
  HEADER_WIDTH_PX,
  RULER_HEIGHT_PX,
  resolveTheme,
} from "./constants";
import type { ArrangementContext } from "./context";
import { createCreateDragHandler } from "./dragCreate";
import { createLoopDragHandler } from "./dragLoop";
import { createMarqueeDragHandler } from "./dragMarquee";
import { createMoveDragHandler } from "./dragMove";
import { createTrimDragHandler } from "./dragTrim";
import { createLaneHeaders, type LaneHeadersView } from "./headers";
import type { ArrangementHit } from "./hits";
import { createHitTesters } from "./hits";
import { createArrangementKeyBindings, splitSelectionAt, toggleLoopOnSelection } from "./keys";
import { createArrangementClipsLayer, createArrangementGridLayer, drawSelectionAndHover } from "./layers";
import { createRuler, type RulerView } from "./ruler";
import type { ArrangementScene } from "./scene";
import { createArrangementScene } from "./scene";

/** Optional extras on top of the frozen `ArrangementOptions`. All optional,
 *  so `createArrangement` still satisfies `CreateArrangement`. */
export interface ArrangementViewOptions extends ArrangementOptions {
  theme?: Partial<ArrangementTheme> | undefined;
  laneHeightPx?: number | undefined;
  dpr?: number | undefined;
}

/** The kit's widening of `ArrangementView` (same pattern as `KitEditorHost`):
 *  everything the app shell's toolbar and the tests want, additively. */
export interface KitArrangementView extends ArrangementView {
  readonly host: KitEditorHost<ArrangementHit>;
  readonly scene: ArrangementScene;
  readonly playheadTicks: Ticks;
  /** Toolbar verb: split the selection at a song tick (defaults to the
   *  playhead). Returns how many clips were split. */
  splitSelection(atTick?: Ticks | undefined): number;
  /** Toolbar verb: toggle the loop brace over the selection. */
  toggleLoop(): number;
  /** Re-measures the container (tests, and after a layout change). */
  measure(): void;
}

/** Clip ids a command created, read off the patch stream — the contract's
 *  way to learn ids minted inside a command factory. */
export function createdClipIds(patches: readonly Patch[]): ClipId[] {
  const out: ClipId[] = [];
  for (const patch of patches) {
    if (patch.op !== "add" || patch.path.length !== 2 || patch.path[0] !== "clips") continue;
    const id = patch.path[1];
    if (typeof id === "string") out.push(id);
  }
  return out;
}

function cell(parent: HTMLElement, column: number, row: number, overflow: string): HTMLElement {
  const el = document.createElement("div");
  el.style.gridColumn = String(column);
  el.style.gridRow = String(row);
  el.style.position = "relative";
  el.style.overflow = overflow;
  el.style.minWidth = "0";
  el.style.minHeight = "0";
  parent.appendChild(el);
  return el;
}

export function createArrangementView(options: ArrangementViewOptions): KitArrangementView {
  const theme = resolveTheme(options.theme);
  const store = options.store;
  const scene: ArrangementScene = createArrangementScene(store.getState());
  const selection: SelectionModel<ClipId> = createSelectionModel<ClipId>();

  let playheadTicks: Ticks = 0;
  let pendingSelectCreated = false;
  let disposed = false;

  // --- DOM shell ------------------------------------------------------------

  const root = document.createElement("div");
  root.className = "fbl-arrangement";
  root.style.position = "relative";
  root.style.display = "grid";
  root.style.gridTemplateColumns = `${String(HEADER_WIDTH_PX)}px minmax(0, 1fr)`;
  root.style.gridTemplateRows = `${String(RULER_HEIGHT_PX)}px minmax(0, 1fr)`;
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.background = theme.background;
  root.style.color = theme.headerText;
  options.container.appendChild(root);

  const cornerEl = cell(root, 1, 1, "hidden");
  cornerEl.className = "fbl-arr-readout";
  cornerEl.style.font = "11px ui-monospace, monospace";
  cornerEl.style.display = "flex";
  cornerEl.style.alignItems = "center";
  cornerEl.style.padding = "0 6px";
  cornerEl.style.background = theme.rulerBackground;
  cornerEl.style.color = theme.rulerText;

  const rulerCell = cell(root, 2, 1, "hidden");
  const headersCell = cell(root, 1, 2, "hidden");
  const contentCell = cell(root, 2, 2, "hidden");

  // --- layers (constructed before the host, which owns the renderer) --------

  let host: KitEditorHost<ArrangementHit> | null = null;
  const hoveredClipId = (): ClipId | null => {
    const hover = host?.gestures.hover ?? null;
    return hover !== null && hover.kind === "clip" ? hover.clipId : null;
  };

  const gridLayerRef: { layer: EditorLayer | null } = { layer: null };
  const clipsLayer = createArrangementClipsLayer({ scene, theme });

  // SS9 offers two routes for the overlay; this editor takes the "one
  // hand-written overlay layer" one, because it draws selection and hover
  // UNDER whatever ghosts the active handler contributes.
  const overlayLayer: EditorLayer = {
    kind: "overlay",
    draw(frame: LayerFrame): void {
      drawSelectionAndHover(frame, { scene, theme, selection, hoveredClipId });
      host?.gestures.drawActivePreview(frame);
    },
  };

  // --- the kit host ---------------------------------------------------------

  const hostOptions = {
    container: contentCell,
    store,
    layers: [] as EditorLayer[],
    viewport: { pxPerRow: options.laneHeightPx ?? DEFAULT_LANE_HEIGHT_PX },
    ...(options.grid === undefined ? {} : { grid: options.grid }),
    ...(options.dpr === undefined ? {} : { dpr: options.dpr }),
  };

  // The grid layer needs the host's `Grid`; the host needs the layers. Build
  // the layer list around a late-bound reference rather than reaching into the
  // renderer afterwards.
  const gridLayer: EditorLayer = {
    kind: "grid",
    draw(frame: LayerFrame): void {
      gridLayerRef.layer?.draw(frame);
    },
  };
  hostOptions.layers = [gridLayer, clipsLayer, overlayLayer];

  host = createEditorHost<ArrangementHit>(hostOptions);
  gridLayerRef.layer = createArrangementGridLayer({ scene, theme, grid: host.grid });

  const viewport = host.viewport;
  const renderer = host.renderer;

  // --- context + verbs ------------------------------------------------------

  const context: ArrangementContext = {
    store,
    commands: options.commands,
    selection,
    scene,
    playheadTicks: () => playheadTicks,
    openClip: (clipId: ClipId) => {
      options.onOpenClip?.(clipId);
    },
    selectChannel: (channelId: ChannelId) => {
      options.onSelectChannel?.(channelId);
    },
    selectCreatedClips: () => {
      pendingSelectCreated = true;
    },
  };

  for (const tester of createHitTesters(scene, viewport)) host.gestures.registerHitTester(tester);
  host.gestures.registerDragHandler(createLoopDragHandler(context, theme));
  host.gestures.registerDragHandler(createTrimDragHandler(context, theme));
  host.gestures.registerDragHandler(createMoveDragHandler(context, theme));
  host.gestures.registerDragHandler(createCreateDragHandler(context, theme));
  host.gestures.registerDragHandler(createMarqueeDragHandler(context, theme));
  host.gestures.registerKeyBinding(createArrangementKeyBindings(context, host.grid));

  // --- ruler + headers ------------------------------------------------------

  const ruler: RulerView = createRuler({
    container: rulerCell,
    viewport,
    grid: host.grid,
    theme,
    doc: store.getState(),
    readout: cornerEl,
    // SS12's loop brace is document state, so the ruler edits it through the
    // command bus like everything else — one entry per completed drag.
    onSetLoop: (loop) => {
      store.dispatch(options.commands.setLoopRegion(loop));
    },
    ...(options.onSeek === undefined ? {} : { onSeek: options.onSeek }),
    ...(options.dpr === undefined ? {} : { dpr: options.dpr }),
  });

  const headers: LaneHeadersView = createLaneHeaders({
    container: headersCell,
    viewport,
    scene,
    store,
    commands: options.commands,
    theme,
    ...(options.onSelectChannel === undefined ? {} : { onSelectChannel: options.onSelectChannel }),
  });

  // --- scroll extents -------------------------------------------------------

  const updateLimits = (): void => {
    const doc = scene.doc;
    const tail = ticksPerBar(doc.timeSignature) * CONTENT_TAIL_BARS;
    viewport.setLimits({
      maxTick: Math.max(tail, scene.contentEndTick() + tail),
      maxRow: Math.max(0, scene.rowCount() - 1),
    });
  };
  updateLimits();

  // --- subscriptions --------------------------------------------------------

  let lastWidthPx = viewport.widthPx;
  const unsubscribeViewport = viewport.onChange(() => {
    if (viewport.widthPx !== lastWidthPx) {
      lastWidthPx = viewport.widthPx;
      ruler.resize(viewport.widthPx);
    }
  });
  ruler.resize(viewport.widthPx);

  const unsubscribeSelection = selection.onChange(() => {
    // Selection is ephemeral and lives in the OVERLAY: a 2,000-clip content
    // layer must not repaint because a highlight changed (SS9).
    renderer.invalidate("overlay");
  });

  const pruneSelection = (doc: ProjectSnapshot): void => {
    const gone = selection.ids().filter((id) => doc.clips[id] === undefined);
    if (gone.length > 0) selection.remove(gone);
  };

  const unsubscribeStore = store.onChange((change: DocumentChange) => {
    const result = scene.update(change.doc, change.patches);
    if (result.structure) {
      headers.rebuild();
      updateLimits();
      renderer.invalidate(["grid", "content"]);
    }
    if (result.clips) {
      updateLimits();
      pruneSelection(change.doc);
      // The OVERLAY too: the selection outline and the hover highlight are
      // drawn from `scene.clip(id)` geometry (layers.ts), so a clip that
      // moves/trims without a pointer gesture — an arrow-key nudge, undo/redo,
      // a toolbar verb — would otherwise leave its outline painted at the old
      // position until some unrelated event dirtied the layer. The piano roll
      // does the same (`ctx.invalidateContent` -> ["content", "overlay"]).
      renderer.invalidate(["content", "overlay"]);
    }
    if (result.song || result.structure) {
      // A load / replace reports itself as a full rebuild, and it can carry a
      // different tempo map and time signature — the ruler must re-read both.
      ruler.setDocument(change.doc);
      if (result.song) renderer.invalidate("grid");
    }
    if (pendingSelectCreated) {
      pendingSelectCreated = false;
      const created = createdClipIds(change.patches);
      if (created.length > 0) selection.set(created);
    }
  });

  const view: KitArrangementView = {
    element: root,
    host,
    scene,
    selection,
    get playheadTicks() {
      return playheadTicks;
    },

    setPlayheadTicks(tick: Ticks): void {
      playheadTicks = tick;
      // Both of these are style writes: playback never dirties a canvas (SS9).
      host?.playhead.setTicks(tick);
      ruler.setPlayheadTicks(tick);
    },

    setSelectedChannel(channelId: ChannelId | null): void {
      if (headers.selectedChannel === channelId) return;
      headers.setSelectedChannel(channelId);
    },

    setGrid(settings: Partial<GridSettings>): void {
      // SS10's grid override menu (shared by both editors through the kit's
      // `Grid`); the host invalidates the grid + content layers itself.
      host?.grid.setSettings(settings);
    },

    reveal(clipId: ClipId): void {
      const clip = scene.clip(clipId);
      if (clip === undefined) return;
      const row = scene.rowOfClip(clipId);
      viewport.revealTick(clip.start, 24);
      if (row >= 0) viewport.revealRow(row, 0);
    },

    splitSelection(atTick?: Ticks | undefined): number {
      return splitSelectionAt(context, atTick ?? playheadTicks);
    },

    toggleLoop(): number {
      return toggleLoopOnSelection(context);
    },

    measure(): void {
      host?.measure();
      ruler.resize(viewport.widthPx);
    },

    focus(): void {
      host?.focus();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeStore();
      unsubscribeSelection();
      unsubscribeViewport();
      ruler.dispose();
      headers.dispose();
      host?.dispose();
      root.remove();
    },
  };

  return view;
}

/** The frozen contract's factory shape (src/types/editor.ts). */
export const createArrangement: CreateArrangement = createArrangementView;
