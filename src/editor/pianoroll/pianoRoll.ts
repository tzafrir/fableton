// SS10, assembled: the piano roll as a skin over the SS9 kit.
//
// The view owns only what SS9 says an editor owns — "its scene and its verbs":
//   scene : three layers (layers.ts) over one context (context.ts)
//   verbs : the FSM's drag handlers (handlers.ts) + the key map (keymap.ts)
// Everything else — coordinates, thresholds, capture, preview lifetime,
// cancellation, the single dispatch, the DOM playhead — is the kit's.
//
// Document reads are targeted (SS13): the store's patch stream tells the view
// whether a change touched THIS clip, so an edit somewhere else in the project
// costs one array comparison, not a re-index.

import type { Patch, ProjectSnapshot } from "../../types/commands";
import type { ClipId, NoteId } from "../../types/ids";
import type {
  CreatePianoRoll,
  PianoRollOptions,
  PianoRollView,
  ToolMode,
} from "../../types/editor";
import type { Ticks } from "../../types/time";
import { createEditorHost, type KitEditorHost } from "../kit/host";
import { createSelectionModel } from "../kit/selection";
import { DEFAULT_PX_PER_ROW } from "../kit/viewport";
import { createKeyboardAudition } from "./audition";
import { createPianoRollContext, type ContextRef, type PianoRollContext } from "./context";
import { createPianoRollDragHandlers } from "./handlers";
import { createPianoRollHitTester, type PianoRollHit } from "./hits";
import { createPianoRollKeyBinding } from "./keymap";
import { createPianoRollLayers } from "./layers";
import {
  MAX_PITCH,
  MIN_PITCH,
  createPianoRollLayout,
  rowOfPitch,
  type PianoRollLayout,
} from "./layout";
import { DEFAULT_PIANO_ROLL_THEME, type PianoRollTheme } from "./theme";

/** Vertical zoom the roll opens at: one semitone per row, 16 px tall. */
export const DEFAULT_ROW_HEIGHT_PX = DEFAULT_PX_PER_ROW;

/** Pitches shown when the clip is empty (a comfortable two octaves at C4). */
const DEFAULT_LOW_PITCH = 55;
const DEFAULT_HIGH_PITCH = 79;

export interface PianoRollViewOptions extends PianoRollOptions {
  theme?: PianoRollTheme | undefined;
  dpr?: number | undefined;
}

/**
 * How much a patch set forces this view to redraw (SS13: "a targeted update,
 * not a full re-scan"). An edit to another clip, another track or a param
 * costs one pass over the patch paths and no repaint at all.
 */
export type RedrawScope = "all" | "content" | "none";

export function redrawScopeOf(
  patches: readonly Patch[],
  clipId: ClipId | null,
): RedrawScope {
  let scope: RedrawScope = "none";
  for (const patch of patches) {
    const head = patch.path[0];
    // A whole-document replace, a tempo/signature change: the grid moves too.
    if (patch.path.length === 0 || head === "timeSignature" || head === "tempo") return "all";
    if (head === "clips" && (patch.path.length === 1 || patch.path[1] === clipId)) {
      scope = "content";
    }
  }
  return scope;
}

/** Note ids an "add" patch created inside `clipId` (SS13's patch stream). */
export function createdNoteIds(patches: readonly Patch[], clipId: ClipId): NoteId[] {
  const out: NoteId[] = [];
  for (const patch of patches) {
    if (patch.op !== "add") continue;
    const [clips, id, notes] = patch.path;
    if (clips !== "clips" || id !== clipId || notes !== "notes") continue;
    const value = patch.value as { id?: unknown } | null;
    if (value !== null && typeof value === "object" && typeof value.id === "string") {
      out.push(value.id);
    }
  }
  return out;
}

export const createPianoRoll: CreatePianoRoll = (
  options: PianoRollOptions,
): PianoRollView => {
  const opts = options as PianoRollViewOptions;
  const selection = createSelectionModel<NoteId>();
  const theme = opts.theme ?? DEFAULT_PIANO_ROLL_THEME;

  // The context needs the host's viewport/grid, and the host's layers and
  // handlers need the context: they are wired through this ref, which is
  // resolved before the first rAF draw or pointer event can reach them.
  let context: PianoRollContext | null = null;
  const ref: ContextRef = () => {
    if (context === null) throw new Error("piano roll used before it was mounted");
    return context;
  };

  const audition = createKeyboardAudition(() => ref().audition);

  const host: KitEditorHost<PianoRollHit> = createEditorHost<PianoRollHit>({
    container: options.container,
    store: options.store,
    layers: createPianoRollLayers(ref, {
      previewOf: (): unknown => host.gestures.preview,
      theme,
    }),
    viewport: { pxPerRow: DEFAULT_ROW_HEIGHT_PX, limits: { minRow: 0, maxRow: MAX_PITCH + 1 } },
    grid: options.grid,
    hitTesters: [createPianoRollHitTester(ref)],
    dragHandlers: createPianoRollDragHandlers(ref),
    keyBindings: [createPianoRollKeyBinding(ref, { audition })],
    dpr: opts.dpr,
  });

  const layout: PianoRollLayout = createPianoRollLayout(host.viewport);

  context = createPianoRollContext({
    store: options.store,
    commands: options.commands,
    selection,
    viewport: host.viewport,
    grid: host.grid,
    layout,
    clipId: options.clipId,
    tool: options.tool ?? "select",
    audition: options.audition ?? null,
    onSeek: options.onSeek,
    invalidateOverlay: () => {
      host.renderer.invalidate("overlay");
    },
    invalidateContent: () => {
      host.renderer.invalidate(["content", "overlay"]);
    },
  });
  const ctx = context;

  // --- vertical framing -----------------------------------------------------

  const revealPitches = (): void => {
    const notes = ctx.notes();
    let low = DEFAULT_LOW_PITCH;
    let high = DEFAULT_HIGH_PITCH;
    if (notes.length > 0) {
      low = MAX_PITCH;
      high = MIN_PITCH;
      for (const note of notes) {
        if (note.pitch < low) low = note.pitch;
        if (note.pitch > high) high = note.pitch;
      }
    }
    const rowsVisible = Math.max(
      1,
      (layout.noteBottomPx - layout.noteTopPx) / host.viewport.pxPerRow,
    );
    const center = (rowOfPitch(high) + rowOfPitch(low)) / 2;
    const top = Math.min(
      Math.max(0, center - rowsVisible / 2),
      Math.max(0, MAX_PITCH + 1 - rowsVisible),
    );
    host.viewport.setScroll(host.viewport.scrollTicks, top);
  };

  revealPitches();

  // --- document + selection subscriptions -----------------------------------

  const pruneSelection = (doc: ProjectSnapshot): void => {
    if (selection.size === 0) return;
    const clipId = ctx.clipId;
    const notes = clipId === null ? undefined : doc.clips[clipId]?.notes;
    if (notes === undefined) {
      selection.clear();
      return;
    }
    const live = new Set(notes.map((note) => note.id));
    const gone = selection.ids().filter((id) => !live.has(id));
    if (gone.length > 0) selection.remove(gone);
  };

  const unsubscribeStore = options.store.onChange((change) => {
    const clipId = ctx.clipId;
    if (clipId === null) return;
    // A note created by click/paint/duplicate becomes the selection, so the
    // keyboard map can act on it straight away.
    const scope = redrawScopeOf(change.patches, clipId);
    if (scope === "none") return;
    const created = createdNoteIds(change.patches, clipId);
    if (created.length > 0 && change.source === "command") selection.set(created);
    pruneSelection(change.doc);
    if (scope === "all") host.renderer.invalidateAll();
    else ctx.invalidateContent();
  });

  const unsubscribeSelection = selection.onChange(() => {
    ctx.invalidateOverlay();
  });

  // --- the view -------------------------------------------------------------

  let disposed = false;

  const view: PianoRollView = {
    element: host.element,
    selection,

    get clipId(): ClipId | null {
      return ctx.clipId;
    },

    setClip(clipId: ClipId | null): void {
      if (ctx.clipId === clipId) return;
      ctx.clipId = clipId;
      selection.clear();
      audition.stopAll();
      revealPitches();
      host.renderer.invalidateAll();
    },

    setTool(tool: ToolMode): void {
      if (ctx.tool === tool) return;
      ctx.tool = tool;
      host.renderer.invalidate("overlay");
    },

    setPlayheadTicks(tick: Ticks): void {
      // SS9: a DOM transform, never a canvas invalidation.
      host.playhead.setTicks(tick);
    },

    focus(): void {
      host.focus();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeStore();
      unsubscribeSelection();
      audition.stopAll();
      ctx.audition?.allNotesOff();
      host.dispose();
    },
  };

  return view;
};
