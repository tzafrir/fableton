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

import type { Patch } from "../../types/commands";
import type { ClipId, NoteId } from "../../types/ids";
import type {
  CreatePianoRoll,
  PianoRollOptions,
  PianoRollView,
  ToolMode,
} from "../../types/editor";
import type { Ticks } from "../../types/time";
import { ticksPerBar } from "../../time";
import type { GridSettings } from "../../types/viewport";
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
import { createKeyGutter } from "./keyGutter";
import { KEY_GUTTER_WIDTH_PX } from "./keyNames";
import { DEFAULT_PIANO_ROLL_THEME, type PianoRollTheme } from "./theme";

/** Vertical zoom the roll opens at: one semitone per row, 16 px tall. */
export const DEFAULT_ROW_HEIGHT_PX = DEFAULT_PX_PER_ROW;

/** Pitches shown when the clip is empty (a comfortable two octaves at C4). */
const DEFAULT_LOW_PITCH = 55;
const DEFAULT_HIGH_PITCH = 79;

/** Empty bars kept scrollable past the end of the clip, so the last note is
 *  never glued to the right edge. SS9: "`maxTick`/`maxRow` follow the
 *  content" — the arrangement's `CONTENT_TAIL_BARS`, roll flavour. */
const CONTENT_TAIL_BARS = 2;

/** Air left past the clip's end when the roll frames it — enough that the
 *  end marker reads as an edge rather than as the canvas running out. */
const FRAME_TAIL_FRACTION = 0.06;

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

/**
 * Note ids that appeared in the clip since the last change.
 *
 * NOT read off the patch ops: `clip.notes` is a SORTED ARRAY, and immer diffs
 * a grown array as `replace` on every shifted index plus ONE `add` carrying
 * whatever ended up at the new tail. Reading the `add`'s value therefore
 * names a pre-existing note whenever the created note does not sort last —
 * so a note created left of / below existing content would hand the keyboard
 * map (which is selection-centric, SS10) a note the user never touched.
 * Comparing id sets is exact for every creation verb: dbl-click, paint,
 * `DragDup` and `Cmd/Ctrl+D` alike.
 */
export function createdNoteIds(
  previousIds: ReadonlySet<NoteId>,
  notes: readonly { readonly id: NoteId }[],
): NoteId[] {
  const out: NoteId[] = [];
  for (const note of notes) {
    if (!previousIds.has(note.id)) out.push(note.id);
  }
  return out;
}

/**
 * The kit-flavoured view, mirroring `KitArrangementView`: the shell only
 * needs `PianoRollView`, but the tests (and any future toolbar verb) need
 * the host — and `measure()`, because the roll now nests its canvas in a
 * grid cell beside the key strip, and jsdom reports a zero rect for both.
 */
export interface KitPianoRollView extends PianoRollView {
  readonly host: KitEditorHost<PianoRollHit>;
  /** Re-measures the canvas cell now (tests, and after a layout change). */
  measure(): void;
}

export function createPianoRollView(options: PianoRollOptions): KitPianoRollView {
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

  // Two columns: the key strip, then the editor canvas. The strip takes its
  // width OUT of the editor's rather than sitting on top of it, so a note at
  // tick 0 and a key name can never occupy the same pixel (see keyGutter.ts).
  const root = document.createElement("div");
  root.className = "fbl-pianoroll";
  root.style.display = "grid";
  root.style.gridTemplateColumns = `${String(KEY_GUTTER_WIDTH_PX)}px minmax(0, 1fr)`;
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.minHeight = "0";
  options.container.appendChild(root);

  const gutterCell = document.createElement("div");
  gutterCell.style.overflow = "hidden";
  gutterCell.style.minWidth = "0";
  root.appendChild(gutterCell);

  const canvasCell = document.createElement("div");
  canvasCell.style.position = "relative";
  canvasCell.style.overflow = "hidden";
  canvasCell.style.minWidth = "0";
  root.appendChild(canvasCell);

  const host: KitEditorHost<PianoRollHit> = createEditorHost<PianoRollHit>({
    container: canvasCell,
    store: options.store,
    layers: createPianoRollLayers(ref, {
      previewOf: (): unknown => host.gestures.preview,
      theme,
    }),
    viewport: { pxPerRow: DEFAULT_ROW_HEIGHT_PX, limits: { minRow: 0, maxRow: MAX_PITCH + 1 } },
    // The ruler is drawn INSIDE this canvas stack, so row 0 starts below it:
    // without this the row zoom would anchor 20 px (1.25 rows) off the pitch
    // under the cursor (SS9 "keeps time under cursor fixed", row axis).
    rowOriginPx: () => layout.noteTopPx,
    grid: options.grid,
    hitTesters: [createPianoRollHitTester(ref)],
    dragHandlers: createPianoRollDragHandlers(ref),
    keyBindings: [createPianoRollKeyBinding(ref, { audition })],
    dpr: opts.dpr,
  });

  const layout: PianoRollLayout = createPianoRollLayout(host.viewport);

  // The strip redraws on any viewport change (row scroll, row zoom, resize),
  // which `createKeyGutter` subscribes to itself.
  const keyGutter = createKeyGutter({
    container: gutterCell,
    viewport: host.viewport,
    layout,
    theme,
    ...(opts.dpr === undefined ? {} : { dpr: opts.dpr }),
  });

  /** The transport position, as last pushed by the shell — in SONG ticks. */
  let playheadSongTicks: Ticks = 0;

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

  // --- scroll extents -------------------------------------------------------

  /** The clip's own extent in ticks: its length, or the end of a note that
   *  sticks out past it. Shared by the scroll limits and the opening frame. */
  const contentEndTicks = (): Ticks => {
    let end = ctx.clipLength();
    for (const note of ctx.notes()) {
      const noteEnd = note.start + note.dur;
      if (noteEnd > end) end = noteEnd;
    }
    return end;
  };

  /** SS9's `ViewportLimits` contract: "maxTick/maxRow follow the content".
   *  The roll's content is the clip: its length, or the end of its longest
   *  note when a note sticks out past it, plus a two-bar tail. */
  const updateLimits = (): void => {
    const doc = options.store.getState();
    const bar = ticksPerBar(doc.timeSignature);
    const end = contentEndTicks();
    host.viewport.setLimits({ maxTick: Math.max(bar, end + bar * CONTENT_TAIL_BARS) });
  };
  updateLimits();

  // --- vertical framing -----------------------------------------------------

  /** Horizontal counterpart of `revealPitches`: open on the WHOLE clip.
   *
   *  The roll used to open at `DEFAULT_PX_PER_TICK` — a fixed ~192 px per bar
   *  — which is the right editing zoom for a one-bar clip and the wrong one
   *  for everything else: an eight-bar clip opened showing its first two bars
   *  with no hint that the rest existed. A clip is the unit the roll edits,
   *  so the clip is what it frames, and the user zooms in from there. */
  const revealClipSpan = (): void => {
    const width = host.viewport.widthPx;
    const current = host.viewport.pxPerTick;
    if (width <= 0 || current <= 0) return;
    const end = contentEndTicks();
    if (end <= 0) return;
    const target = width / (end * (1 + FRAME_TAIL_FRACTION));
    // `zoomAt` is the only way in, and it clamps to the viewport's limits for
    // free; anchoring at x = 0 leaves `scrollTicks` alone so the clip's start
    // stays pinned to the left edge.
    host.viewport.zoomAt(0, target / current);
    host.viewport.setScroll(0, host.viewport.scrollRows);
  };

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

  // Framing needs a SIZE. A roll mounted into a container the browser has
  // not laid out yet — a hidden tab, or any test harness — measures zero, and
  // framing against zero leaves the clip's notes off screen the moment the
  // panel is shown. So the first framing at a REAL size is the one that
  // counts; until then it is retried on the next size change.
  let framed = false;
  let framing = false;
  const frameOnce = (): void => {
    if (framed || framing) return;
    if (layout.noteBottomPx - layout.noteTopPx <= 0) return;
    if (host.viewport.widthPx <= 0) return;
    // Both halves move the viewport, and a viewport move re-enters this
    // through `onChange` — the guard makes that re-entry a no-op rather than
    // a second framing that fights the first.
    framing = true;
    try {
      revealPitches();
      revealClipSpan();
    } finally {
      framing = false;
    }
    framed = true;
  };
  frameOnce();
  const unsubscribeViewport = host.viewport.onChange(() => {
    frameOnce();
  });

  // --- document + selection subscriptions -----------------------------------

  /** The clip's note ids as of the last change this view saw. */
  const noteIdsOf = (notes: readonly { readonly id: NoteId }[]): Set<NoteId> =>
    new Set(notes.map((note) => note.id));

  let knownNoteIds: Set<NoteId> = noteIdsOf(ctx.notes());

  const pruneSelection = (live: ReadonlySet<NoteId> | null): void => {
    if (selection.size === 0) return;
    if (live === null) {
      selection.clear();
      return;
    }
    const gone = selection.ids().filter((id) => !live.has(id));
    if (gone.length > 0) selection.remove(gone);
  };

  const unsubscribeStore = options.store.onChange((change) => {
    const clipId = ctx.clipId;
    if (clipId === null) return;
    const scope = redrawScopeOf(change.patches, clipId);
    if (scope === "none") return;
    const notes: readonly { readonly id: NoteId }[] | undefined = change.doc.clips[clipId]?.notes;
    // A note created by click/paint/duplicate becomes the selection, so the
    // keyboard map can act on it straight away.
    const created = notes === undefined ? [] : createdNoteIds(knownNoteIds, notes);
    knownNoteIds = notes === undefined ? new Set() : noteIdsOf(notes);
    if (created.length > 0 && change.source === "command") selection.set(created);
    pruneSelection(notes === undefined ? null : knownNoteIds);
    updateLimits();
    if (scope === "all") host.renderer.invalidateAll();
    else ctx.invalidateContent();
  });

  const unsubscribeSelection = selection.onChange(() => {
    ctx.invalidateOverlay();
  });

  // --- the view -------------------------------------------------------------

  let disposed = false;

  const view: KitPianoRollView = {
    element: host.element,
    host,
    selection,

    measure(): void {
      host.measure();
      keyGutter.draw();
    },

    get clipId(): ClipId | null {
      return ctx.clipId;
    },

    setClip(clipId: ClipId | null): void {
      if (ctx.clipId === clipId) return;
      ctx.clipId = clipId;
      knownNoteIds = noteIdsOf(ctx.notes());
      selection.clear();
      audition.stopAll();
      updateLimits();
      // Opening a different clip re-frames on that clip — including its
      // length, which is the whole point of framing at all. Going back
      // through `frameOnce` (rather than calling the two reveals here) is
      // what keeps a clip opened into a zero-sized panel framed later,
      // when the panel is actually shown.
      framed = false;
      frameOnce();
      // The clip moved under the playhead's song tick: re-project it onto the
      // new clip's axis (see `setPlayheadTicks`).
      host.playhead.setTicks(playheadSongTicks - ctx.clipStart());
      host.renderer.invalidateAll();
    },

    setGrid(settings: Partial<GridSettings>): void {
      // SS10's grid override menu. The host's `Grid` already re-notifies (and
      // the host already invalidates grid + content) when the division
      // actually changes, so this is a pass-through.
      host.grid.setSettings(settings);
    },

    setTool(tool: ToolMode): void {
      if (ctx.tool === tool) return;
      ctx.tool = tool;
      host.renderer.invalidate("overlay");
    },

    setPlayheadTicks(tick: Ticks): void {
      // The shell speaks SONG ticks; this viewport is CLIP-RELATIVE (SS10:
      // `Note.start` is clip-relative, and the grid shades past
      // `xOf(clipLength())`), so the offset is applied here — the one place
      // the two axes meet on the way in. SS9: a DOM transform, never a canvas
      // invalidation.
      playheadSongTicks = tick;
      host.playhead.setTicks(tick - ctx.clipStart());
    },

    focus(): void {
      host.focus();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeStore();
      unsubscribeViewport();
      unsubscribeSelection();
      audition.stopAll();
      ctx.audition?.allNotesOff();
      host.dispose();
      keyGutter.dispose();
      root.remove();
    },
  };

  return view;
}

export const createPianoRoll: CreatePianoRoll = createPianoRollView;
