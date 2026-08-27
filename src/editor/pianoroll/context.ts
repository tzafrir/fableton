// What every piano-roll hit-tester, drag handler, key binding and layer reads.
//
// SS9: "each editor only supplies its scene and its verbs" — this is the scene
// side, assembled once so the verbs stay pure functions of it. It holds ONLY
// ephemeral state plus a read path into the document (SS13: selection, tool
// and hover are never in the document, never undoable, never saved).
//
// Nothing here imports the kit's implementation or the command package: a test
// can build a context over a hand-made store and drive the whole FSM headless
// (SS15).

import type { ClipId, NoteId } from "../../types/ids";
import type { DocumentStore, ProjectCommands } from "../../types/commands";
import type { AuditionSink, SelectionModel, ToolMode } from "../../types/editor";
import type { Ticks } from "../../types/time";
import type { Grid, Viewport } from "../../types/viewport";
import type { PianoRollLayout, RONote } from "./layout";

const NO_NOTES: readonly RONote[] = [];

export interface PianoRollContext {
  readonly store: DocumentStore;
  readonly commands: ProjectCommands;
  readonly selection: SelectionModel<NoteId>;
  readonly viewport: Viewport;
  readonly grid: Grid;
  readonly layout: PianoRollLayout;

  /** The clip being edited; `null` is the empty state (no verbs claim). */
  clipId: ClipId | null;
  /** SS10: marquee/select vs. pencil (`Paint`). */
  tool: ToolMode;
  /** SS10: "audition on pitch change"; `null` in tests that do not care. */
  audition: AuditionSink | null;

  /** The clip's notes, already sorted by `(start, pitch)` (invariant 4). */
  notes(): readonly RONote[];
  noteById(id: NoteId): RONote | undefined;
  /** Selected notes that still exist in the clip, in document order. */
  selectedNotes(): readonly RONote[];
  clipLength(): Ticks;

  /** Ruler drag (the shell wires it to `transport.seek`). */
  seek(tick: Ticks): void;
  /** SS9's layer discipline: a gesture may dirty the overlay and nothing else. */
  invalidateOverlay(): void;
  invalidateContent(): void;
}

export interface PianoRollContextOptions {
  store: DocumentStore;
  commands: ProjectCommands;
  selection: SelectionModel<NoteId>;
  viewport: Viewport;
  grid: Grid;
  layout: PianoRollLayout;
  clipId?: ClipId | null | undefined;
  tool?: ToolMode | undefined;
  audition?: AuditionSink | null | undefined;
  onSeek?: ((tick: Ticks) => void) | undefined;
  invalidateOverlay?: (() => void) | undefined;
  invalidateContent?: (() => void) | undefined;
}

export function createPianoRollContext(
  options: PianoRollContextOptions,
): PianoRollContext {
  // `noteById` is called once per pointer event at most; the map is rebuilt
  // only when the store hands out a NEW notes array (structural sharing makes
  // identity a reliable cache key).
  let indexedNotes: readonly RONote[] | null = null;
  let byId = new Map<NoteId, RONote>();

  const ctx: PianoRollContext = {
    store: options.store,
    commands: options.commands,
    selection: options.selection,
    viewport: options.viewport,
    grid: options.grid,
    layout: options.layout,
    clipId: options.clipId ?? null,
    tool: options.tool ?? "select",
    audition: options.audition ?? null,

    notes(): readonly RONote[] {
      const id = ctx.clipId;
      if (id === null) return NO_NOTES;
      return ctx.store.getState().clips[id]?.notes ?? NO_NOTES;
    },

    noteById(id: NoteId): RONote | undefined {
      const notes = ctx.notes();
      if (notes !== indexedNotes) {
        indexedNotes = notes;
        byId = new Map(notes.map((note) => [note.id, note] as const));
      }
      return byId.get(id);
    },

    selectedNotes(): readonly RONote[] {
      if (ctx.selection.size === 0) return NO_NOTES;
      return ctx.notes().filter((note) => ctx.selection.has(note.id));
    },

    clipLength(): Ticks {
      const id = ctx.clipId;
      if (id === null) return 0;
      return ctx.store.getState().clips[id]?.length ?? 0;
    },

    seek(tick: Ticks): void {
      options.onSeek?.(tick);
    },

    invalidateOverlay(): void {
      options.invalidateOverlay?.();
    },

    invalidateContent(): void {
      options.invalidateContent?.();
    },
  };

  return ctx;
}

/** Handlers and layers are built before the host exists; they read this. */
export type ContextRef = () => PianoRollContext;
