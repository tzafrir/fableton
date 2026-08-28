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
import type { AuditionSink, PitchNames, SelectionModel, ToolMode } from "../../types/editor";
import type { TickIndex } from "../../types/render";
import type { Ticks } from "../../types/time";
import type { Grid, Viewport } from "../../types/viewport";
import { createTickIndex } from "../kit/tickIndex";
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
  /**
   * MIDI note -> what it is, for a drum-style instrument; `null` for a
   * chromatic one. Ephemeral like `tool` — it describes the DEVICE the clip
   * is played through, never the clip, so it is not document data and the
   * shell pushes it in.
   */
  pitchNames: PitchNames | null;

  /** The clip's notes, already sorted by `(start, pitch)` (invariant 4). */
  notes(): readonly RONote[];
  /** Notes overlapping `[from, to)`, found by binary search — SS9's culling
   *  rule, shared by the hover hit-tester and the marquee so neither walks
   *  the whole clip on a pointermove. Appends into `out` when given, so a
   *  per-frame caller can reuse one array. */
  notesInRange(from: Ticks, to: Ticks, out?: RONote[]): readonly RONote[];
  noteById(id: NoteId): RONote | undefined;
  /** Selected notes that still exist in the clip, in document order. */
  selectedNotes(): readonly RONote[];
  clipLength(): Ticks;
  /**
   * The open clip's position on the SONG timeline (0 when none is open).
   *
   * SS9's coordinate discipline has a second axis boundary in this editor,
   * next to pixels: the roll's whole viewport is CLIP-RELATIVE (`Note.start`
   * is clip-relative, SS10), while the transport and the arrangement speak
   * SONG ticks. Every crossing of that boundary goes through this offset —
   * `seek()` on the way out, `PianoRollView.setPlayheadTicks` on the way in —
   * so no handler and no layer ever holds a tick in the wrong space.
   */
  clipStart(): Ticks;

  /** Ruler drag (the shell wires it to `transport.seek`). Takes a
   *  CLIP-RELATIVE tick and reports a SONG tick, per `clipStart()`. */
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
  pitchNames?: PitchNames | null | undefined;
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

  // Same identity-keyed rebuild for the range index (SS9's binary search).
  const range: TickIndex<RONote> = createTickIndex<RONote>((note) => ({
    start: note.start,
    end: note.start + note.dur,
  }));
  let rangeIndexed: readonly RONote[] | null = null;

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
    pitchNames: options.pitchNames ?? null,

    notes(): readonly RONote[] {
      const id = ctx.clipId;
      if (id === null) return NO_NOTES;
      return ctx.store.getState().clips[id]?.notes ?? NO_NOTES;
    },

    notesInRange(from: Ticks, to: Ticks, out?: RONote[]): readonly RONote[] {
      const notes = ctx.notes();
      if (notes !== rangeIndexed) {
        range.rebuild(notes);
        rangeIndexed = notes;
      }
      return range.inRange(from, to, out);
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

    clipStart(): Ticks {
      const id = ctx.clipId;
      if (id === null) return 0;
      return ctx.store.getState().clips[id]?.start ?? 0;
    },

    seek(tick: Ticks): void {
      // Clip-relative -> song ticks: the shell's `onSeek` reaches
      // `transport.seek`, which knows only the song timeline.
      options.onSeek?.(ctx.clipStart() + tick);
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
