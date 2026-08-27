// SS9 — "Every drag operates on a PREVIEW (ghosts in the overlay) and commits
// exactly one command on release."
//
// One discriminated union for every SS10 gesture, so the overlay layer draws
// ghosts by `kind` and a test can assert the exact geometry the user sees
// BEFORE any command exists. Nothing in here touches the document.

import type { NoteId } from "../../types/ids";
import type { NoteSpan, NoteVelocityEdit } from "../../types/commands";
import type { Ticks } from "../../types/time";

/** SS10's FSM rows, as the handler ids the gesture engine reports. */
export const HANDLER_IDS = {
  /** `DragMove` */
  move: "pianoroll.drag-move",
  /** `DragResizeL` */
  resizeL: "pianoroll.drag-resize-l",
  /** `DragResizeR` */
  resizeR: "pianoroll.drag-resize-r",
  /** `DragDup` (and its `Alt`+vertical velocity sub-mode) */
  dup: "pianoroll.drag-dup",
  /** `Marquee` */
  marquee: "pianoroll.marquee",
  /** `DragVel` */
  velocity: "pianoroll.drag-vel",
  /** `Paint` */
  paint: "pianoroll.paint",
  /** Ruler scrub -> `onSeek` (not an SS10 row; zero document traffic). */
  seek: "pianoroll.seek",
} as const;

/** A note as the overlay draws it mid-drag. Ids are `null` for copies. */
export interface GhostNote {
  readonly id: NoteId | null;
  readonly start: Ticks;
  readonly dur: Ticks;
  readonly pitch: number;
  readonly vel: number;
}

export interface RectPx {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface MovePreview {
  readonly kind: "move";
  readonly noteIds: readonly NoteId[];
  readonly deltaTicks: Ticks;
  readonly deltaPitch: number;
  readonly ghosts: readonly GhostNote[];
  /** Pitch currently sounding from the SS10 "audition on pitch change" rule. */
  readonly auditionPitch: number | null;
}

export interface ResizePreview {
  readonly kind: "resize";
  readonly edge: "l" | "r";
  readonly spans: readonly NoteSpan[];
  readonly ghosts: readonly GhostNote[];
}

export interface DupPreview {
  readonly kind: "dup";
  /** Locked on the first promoted move; see `dragMove.ts`. */
  readonly mode: "duplicate" | "velocity";
  /** `false` until the first move decided `mode`. */
  readonly locked: boolean;
  readonly noteIds: readonly NoteId[];
  readonly deltaTicks: Ticks;
  readonly deltaPitch: number;
  readonly velocities: readonly NoteVelocityEdit[];
  readonly ghosts: readonly GhostNote[];
  readonly auditionPitch: number | null;
}

export interface MarqueePreview {
  readonly kind: "marquee";
  readonly rect: RectPx;
  /** The selection before the drag; restored verbatim on `Esc`. */
  readonly base: readonly NoteId[];
  /** Notes the rectangle currently intersects. */
  readonly hits: readonly NoteId[];
}

export interface VelocityPreview {
  readonly kind: "velocity";
  readonly edits: readonly NoteVelocityEdit[];
  readonly vel: number;
  /** The swept x range (SS10: "set velocity for stalks in x-range"). */
  readonly fromPx: number;
  readonly toPx: number;
}

export interface PaintPreview {
  readonly kind: "paint";
  readonly ghost: GhostNote;
}

export interface SeekPreview {
  readonly kind: "seek";
  readonly tick: Ticks;
}

export type PianoRollPreview =
  | MovePreview
  | ResizePreview
  | DupPreview
  | MarqueePreview
  | VelocityPreview
  | PaintPreview
  | SeekPreview;

/** Previews the overlay draws as note rectangles. */
export function ghostsOf(preview: unknown): readonly GhostNote[] {
  const p = preview as PianoRollPreview | null;
  if (p === null || typeof p !== "object") return [];
  switch (p.kind) {
    case "move":
    case "resize":
    case "dup":
      return p.ghosts;
    case "paint":
      return [p.ghost];
    default:
      return [];
  }
}
