// SS9/SS10 — What an editor IS, on top of the kit: the assembled host
// (viewport + grid + renderer + gesture engine + playhead), the ephemeral
// selection model, and the two M1 editor views the app shell mounts.
//
// "The arrangement lanes, piano roll, and automation lanes are three skins
// over one framework ... each editor only supplies its scene and its verbs"
// (SS9). `EditorHost` is that framework, assembled; `PianoRollView` and
// `ArrangementView` are two skins.
//
// `canvas-kit` (src/editor/kit/) implements `EditorHost` + `SelectionModel`.
// `piano-roll` and `arrangement` implement their views on top of it.

import type { Unsub } from "./common";
import type { ClipId, ChannelId, NoteId } from "./ids";
import type { DocumentStore, ProjectCommands, ProjectSnapshot } from "./commands";
import type {
  DragHandler,
  GestureEngine,
  HitTarget,
  HitTester,
  KeyBinding,
} from "./gesture";
import type { EditorLayer, PlayheadView, Renderer } from "./render";
import type { Ticks } from "./time";
import { TICKS_PER_WHOLE_NOTE } from "./time";
import type { Grid, GridSettings, Viewport, ViewportOptions } from "./viewport";

/** SS10: resize "floor = 1/128 note" — 30 ticks at 960 PPQ. */
export const MIN_NOTE_TICKS = TICKS_PER_WHOLE_NOTE / 128;

/** SS10 keyboard map: `Shift+left/right` = "fine nudge (1/64 note)" = 60 ticks. */
export const FINE_NUDGE_TICKS = TICKS_PER_WHOLE_NOTE / 64;

/** SS10 hit zones: edge zone is `min(6 px, 40% of note width)` per side, so
 *  short notes always keep a grabbable body. */
export const EDGE_ZONE_PX = 6;
export const EDGE_ZONE_FRACTION = 0.4;

/** Trim floor for a clip (1/64 note = 60 ticks): a clip may be short, but a
 *  zero-length one is unclickable and unrepresentable in the ruler. */
export const MIN_CLIP_TICKS = TICKS_PER_WHOLE_NOTE / 64;

/** Velocity of a note created by click/paint before any velocity edit. */
export const DEFAULT_NOTE_VELOCITY = 100;

// --- ephemeral state --------------------------------------------------------

/**
 * Selection is EPHEMERAL (SS13): never in the document, never undoable, never
 * saved. One model per editor; the kit provides the implementation so
 * "`Shift` adds, `Ctrl` toggles" (SS10) behaves identically everywhere.
 */
export interface SelectionModel<TId extends string = string> {
  readonly size: number;
  has(id: TId): boolean;
  ids(): readonly TId[];
  set(ids: Iterable<TId>): void;
  add(ids: Iterable<TId>): void;
  remove(ids: Iterable<TId>): void;
  toggle(ids: Iterable<TId>): void;
  clear(): void;
  onChange(cb: (ids: readonly TId[]) => void): Unsub;
}

/** SS10: marquee/select vs. pencil (note creation by dragging). */
export type ToolMode = "select" | "pencil";

/**
 * SS10: "audition on pitch change" during a move, and on note creation.
 * The app shell supplies one wired to the track's instrument; a test supplies
 * a recorder. Auditions are UI, not transport: they play immediately and are
 * never scheduled, never recorded, never undoable.
 */
export interface AuditionSink {
  noteOn(pitch: number, vel: number): void;
  noteOff(pitch: number): void;
  allNotesOff(): void;
}

// --- the assembled kit host -------------------------------------------------

export interface EditorHostOptions<THit extends HitTarget = HitTarget> {
  /** The editor fills this element; the kit observes its size. */
  container: HTMLElement;
  store: DocumentStore;
  /** Bottom-to-top canvas layers (SS9: grid / content / overlay). */
  layers: readonly EditorLayer[];
  viewport?: ViewportOptions | undefined;
  grid?: Partial<GridSettings> | undefined;
  hitTesters?: readonly HitTester<THit>[] | undefined;
  dragHandlers?: readonly DragHandler<THit, unknown>[] | undefined;
  keyBindings?: readonly KeyBinding[] | undefined;
  dpr?: number | undefined;
}

/**
 * Everything SS9 says the kit owns, assembled and wired: the gesture engine
 * dispatches into `store`, drag updates invalidate the overlay, viewport
 * changes invalidate grid + content, and a resize observer keeps the canvases
 * and the viewport in sync with the container.
 */
export interface EditorHost<THit extends HitTarget = HitTarget> {
  readonly element: HTMLElement;
  readonly viewport: Viewport;
  readonly grid: Grid;
  readonly renderer: Renderer;
  readonly gestures: GestureEngine<THit>;
  readonly playhead: PlayheadView;
  /** Makes the host keyboard-focusable and focused (SS10's key map). */
  focus(): void;
  /** Re-measures the container now (tests, and after a layout change). */
  measure(): void;
  dispose(): void;
}

export type CreateEditorHost = <THit extends HitTarget>(
  options: EditorHostOptions<THit>,
) => EditorHost<THit>;

// --- the two M1 editor views ------------------------------------------------

/** What the app shell needs from any editor it mounts. */
export interface EditorView {
  readonly element: HTMLElement;
  /** Playback position in ticks, pushed at rAF by the shell. SS9: this moves
   *  a DOM node and must never invalidate a canvas layer. */
  setPlayheadTicks(tick: Ticks): void;
  focus(): void;
  dispose(): void;
}

export interface EditorViewOptionsBase {
  container: HTMLElement;
  store: DocumentStore;
  commands: ProjectCommands;
  /** Ruler click / playhead drag. The shell wires it to `transport.seek`. */
  onSeek?: ((tick: Ticks) => void) | undefined;
  grid?: Partial<GridSettings> | undefined;
}

export interface PianoRollOptions extends EditorViewOptionsBase {
  /** The clip being edited; `null` shows the empty state. */
  clipId: ClipId | null;
  audition?: AuditionSink | undefined;
  tool?: ToolMode | undefined;
}

export interface PianoRollView extends EditorView {
  readonly selection: SelectionModel<NoteId>;
  readonly clipId: ClipId | null;
  setClip(clipId: ClipId | null): void;
  setTool(tool: ToolMode): void;
}

export type CreatePianoRoll = (options: PianoRollOptions) => PianoRollView;

export interface ArrangementOptions extends EditorViewOptionsBase {
  /** Double-click on a clip: the shell opens it in the piano roll. */
  onOpenClip?: ((clipId: ClipId) => void) | undefined;
  /** Clicking a lane header selects a track (shell chrome follows). */
  onSelectChannel?: ((channelId: ChannelId) => void) | undefined;
}

export interface ArrangementView extends EditorView {
  readonly selection: SelectionModel<ClipId>;
  /** Scrolls the given clip/track into view (shell "show me this clip"). */
  reveal(clipId: ClipId): void;
}

export type CreateArrangement = (options: ArrangementOptions) => ArrangementView;

/**
 * Both views subscribe to `store.onChange` themselves and re-index only what
 * the patches touched (SS13: "reacting to ... is a targeted update, not a full
 * re-scan"). This is the read signature they use — exported so a test can
 * drive a view with a hand-built snapshot.
 */
export type EditorDocReader = (doc: ProjectSnapshot) => void;
