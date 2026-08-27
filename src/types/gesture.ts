// SS9 — "Gesture state machine. The kit runs one FSM per editor over pointer
// events; editors register hit-testers and drag handlers. Every drag operates
// on a PREVIEW (ghosts in the overlay) and commits exactly one command on
// release; `Esc` aborts with zero document traffic."
//
// The FSM is the reason M1 exists at all (SS1: interactions were ad-hoc), so
// the shape below is deliberately rigid: an editor supplies WHAT is under the
// pointer (hit-testers) and WHAT a drag means (drag handlers), and the kit
// owns thresholds, pointer capture, cursor, modifiers, snapping, preview
// lifetime, cancellation and the single dispatch.
//
// SS15: "gesture FSMs are unit-tested by feeding synthetic pointer-event
// sequences" — every input method therefore takes a PLAIN OBJECT, never a DOM
// event, and the engine works headless.
//
// Implemented by `canvas-kit` in src/editor/kit/.

import type { Unsub } from "./common";
import type { Command } from "./commands";
import type { LayerFrame } from "./render";
import type { Ticks } from "./time";
import type { Grid, Row, Viewport } from "./viewport";

/** SS9/SS10: a drag is promoted after more than this much travel. */
export const DRAG_THRESHOLD_PX = 3;

/**
 * Normalized modifier set. `primary` is the platform's "command" modifier —
 * `meta` on macOS, `ctrl` elsewhere — so every editor writes `primary` and
 * SS10's `Cmd/Ctrl+D` needs no per-call platform test.
 */
export interface Modifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  primary: boolean;
}

/** A pointer position in all three coordinate systems at once. */
export interface EditorPoint {
  /** CSS pixels relative to the editor content origin. */
  xPx: number;
  yPx: number;
  /** `viewport.tAt(xPx)` — integer ticks. */
  tick: Ticks;
  /** `viewport.rowAt(yPx)` — fractional row (see the row convention). */
  row: Row;
}

export interface PointerInput {
  pointerId: number;
  point: EditorPoint;
  /** 0 = left/primary, 1 = middle, 2 = right (matches `PointerEvent`). */
  button: number;
  /** Bitmask of held buttons (matches `PointerEvent.buttons`). */
  buttons: number;
  modifiers: Modifiers;
  /** 1 = single, 2 = double (matches `MouseEvent.detail`). */
  clickCount?: number | undefined;
  native?: PointerEvent | undefined;
}

/**
 * SS9's uniform scroll/zoom: wheel = vertical, `Shift`+wheel = horizontal,
 * `Ctrl/Cmd`+wheel and pinch = zoom-to-cursor. The engine implements exactly
 * that against the viewport; editors do not handle wheel themselves.
 */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  point: EditorPoint;
  modifiers: Modifiers;
  /** Browsers report a trackpad pinch as a wheel event with `ctrlKey`. */
  pinch?: boolean | undefined;
}

export interface KeyInput {
  /** `KeyboardEvent.key`, e.g. `"ArrowUp"`, `"Escape"`, `"d"`. */
  key: string;
  /** `KeyboardEvent.code`, e.g. `"Digit0"` — use it for layout-stable keys. */
  code?: string | undefined;
  modifiers: Modifiers;
  repeat?: boolean | undefined;
}

// --- hit testing ------------------------------------------------------------

/**
 * Whatever an editor resolves the pointer to. Editors extend this with their
 * own zones — the piano roll's `body` / `edgeL` / `edgeR` / `velocity` /
 * `empty` (SS10), the arrangement's `clip` / `clipEdge` / `lane` — and the kit
 * stays generic over it.
 */
export interface HitTarget {
  readonly kind: string;
  /** CSS cursor to show while hovering (SS10: "the cursor reflects it"). */
  readonly cursor?: string | undefined;
}

export interface HitTester<THit extends HitTarget = HitTarget> {
  readonly id: string;
  /** Higher runs first; first non-null result wins. Default 0. */
  readonly priority?: number | undefined;
  hitTest(point: EditorPoint, modifiers: Modifiers): THit | null;
}

// --- drags ------------------------------------------------------------------

export type GesturePhase = "idle" | "pending" | "dragging";

export interface GestureStart<THit extends HitTarget = HitTarget> {
  readonly hit: THit;
  readonly point: EditorPoint;
  readonly modifiers: Modifiers;
  readonly pointerId: number;
  readonly button: number;
  readonly clickCount: number;
  readonly viewport: Viewport;
  readonly grid: Grid;
}

export interface DragUpdate<THit extends HitTarget = HitTarget, TPreview = unknown> {
  readonly start: GestureStart<THit>;
  readonly point: EditorPoint;
  /** LIVE modifiers, which may differ from `start.modifiers`: `Alt` bypasses
   *  snap mid-drag and `Shift` switches to fine mode without a value jump. */
  readonly modifiers: Modifiers;
  readonly deltaPx: { readonly x: number; readonly y: number };
  /** Raw (unsnapped) content deltas; snap them through `start.grid`. */
  readonly deltaTicks: Ticks;
  readonly deltaRows: number;
  readonly preview: TPreview;
  readonly viewport: Viewport;
  readonly grid: Grid;
}

export interface ClickInfo {
  readonly clickCount: number;
  readonly modifiers: Modifiers;
}

/**
 * One verb of one editor. The kit calls, in order:
 *
 *   claim -> (pointer moves > threshold) -> begin -> update* -> commit
 *   claim -> (pointer released under threshold) -> click
 *   ...any of the above interrupted by Esc / pointercancel -> cancel
 *
 * `commit` returns the ONE command for the whole gesture, or `null` when the
 * gesture is not a document edit (SS10 `Marquee`: "commit selection (not
 * undoable)"). Selection changes, auditions and other ephemeral effects are
 * done by the handler itself, in `begin`/`update`/`click` — they are not
 * document state (SS13).
 *
 * `update` returns the NEW preview; the kit stores it and invalidates the
 * overlay layer. A handler must never write to the document outside `commit`.
 */
export interface DragHandler<THit extends HitTarget = HitTarget, TPreview = unknown> {
  readonly id: string;
  /** Higher runs first; first handler to claim owns the gesture. Default 0. */
  readonly priority?: number | undefined;
  /** Does this handler own a pointerdown on this hit with these modifiers? */
  claim(start: GestureStart<THit>): boolean;
  /** Overrides `DRAG_THRESHOLD_PX` for this verb (0 = promote immediately). */
  readonly thresholdPx?: number | undefined;
  /** Cursor while the drag is active; falls back to the hit's cursor. */
  readonly cursor?: string | undefined;
  begin(start: GestureStart<THit>): TPreview;
  update(update: DragUpdate<THit, TPreview>): TPreview;
  commit(update: DragUpdate<THit, TPreview>): Command | null;
  /** Esc, pointercancel, or a lost pointer capture. Zero document traffic. */
  cancel(preview: TPreview, start: GestureStart<THit>): void;
  /** Released under the threshold — a click, not a drag (SS10 `Pending`). */
  click?(start: GestureStart<THit>, info: ClickInfo): Command | null;
  /** Draws this handler's ghosts. The kit's overlay layer calls it for the
   *  ACTIVE handler only; an editor that prefers one big overlay layer can
   *  omit it and read `GestureEngine.preview` instead. */
  drawPreview?(frame: LayerFrame, preview: TPreview): void;
}

/**
 * SS10: "Every action goes through the same commands the mouse uses — the
 * keyboard is a first-class client of the editor, not a bolt-on."
 */
export interface KeyOutcome {
  /** Dispatched by the engine, exactly like a drag's `commit` result. */
  readonly command?: Command | null | undefined;
  /** Default `true` — the engine calls `preventDefault` on the DOM event. */
  readonly preventDefault?: boolean | undefined;
}

export interface KeyBinding {
  readonly id: string;
  readonly priority?: number | undefined;
  /** Return `null` to pass the key to the next binding / the browser. */
  handle(input: KeyInput): KeyOutcome | null;
}

// --- the engine -------------------------------------------------------------

export interface GestureEngineOptions<THit extends HitTarget = HitTarget> {
  /** The element pointer/key events are attached to (the renderer's element).
   *  Omit to drive the engine purely through its input methods (tests). */
  element?: HTMLElement | undefined;
  viewport: Viewport;
  grid: Grid;
  /** Where a `commit`/`click`/key command goes. Normally
   *  `(cmd) => store.dispatch(cmd)`. */
  dispatch: (command: Command) => void;
  /** Called whenever the preview or hover changes; wire to
   *  `renderer.invalidate('overlay')`. */
  invalidateOverlay?: (() => void) | undefined;
  hitTesters?: readonly HitTester<THit>[] | undefined;
  dragHandlers?: readonly DragHandler<THit, unknown>[] | undefined;
  keyBindings?: readonly KeyBinding[] | undefined;
}

/**
 * One FSM per editor. States are SS10's table collapsed to three phases —
 * `idle` / `pending` / `dragging` — with the per-verb behaviour supplied by
 * the registered `DragHandler`s.
 */
export interface GestureEngine<THit extends HitTarget = HitTarget> {
  readonly phase: GesturePhase;
  /** Result of the last hover hit-test; drives the cursor and the editors'
   *  hover highlight. `null` when the pointer is outside or a drag is live. */
  readonly hover: THit | null;
  readonly cursor: string;
  readonly activeHandlerId: string | null;
  /** The live preview of the active drag, `null` otherwise. Editors narrow it
   *  by `activeHandlerId`. */
  readonly preview: unknown;

  registerHitTester(tester: HitTester<THit>): Unsub;
  /** `TPreview` is the handler's own; the engine only stores it. */
  registerDragHandler<TPreview>(handler: DragHandler<THit, TPreview>): Unsub;
  registerKeyBinding(binding: KeyBinding): Unsub;

  pointerDown(input: PointerInput): void;
  pointerMove(input: PointerInput): void;
  pointerUp(input: PointerInput): void;
  pointerCancel(input: PointerInput): void;
  /** `true` when the engine consumed it. */
  wheel(input: WheelInput): boolean;
  keyDown(input: KeyInput): boolean;
  /** Esc: aborts a live drag (revert, no dispatch); in `idle` it is the
   *  editor's own binding that clears selection (SS10). */
  cancel(): void;

  onChange(cb: (engine: GestureEngine<THit>) => void): Unsub;
  dispose(): void;
}

export type CreateGestureEngine = <THit extends HitTarget>(
  options: GestureEngineOptions<THit>,
) => GestureEngine<THit>;
