// SS10 — the piano roll's geometry, and nothing else.
//
// Every pixel<->music conversion the editor needs lives here as a pure
// function of `(viewport, layout)`, so the hit zones ("Body ... left/right
// edge zones: `min(6 px, 40% of note width)`"), the velocity lane stalks and
// the drag handlers all measure the same way and can be unit-tested headless
// (SS15).
//
// The vertical stack, top to bottom:
//
//   [ ruler        ]  bar numbers; click/drag seeks (the shell's `onSeek`)
//   [ note grid    ]  row = 127 - pitch (the frozen row convention, SS9)
//   [ velocity lane]  one stalk per note; drag sets velocity (SS10)
//
// The kit's `Viewport` owns only the note grid's row axis, so the ruler
// offset is added/removed HERE and nowhere else. `EditorPoint.row` (which the
// kit derives from the raw y) is therefore never used by this editor: it uses
// `rowAtY`/`pitchAtY` below.

import type { Note } from "../../types/clip";
import type { Immutable } from "../../types/commands";
import type { Ticks } from "../../types/time";
import type { Row, Viewport } from "../../types/viewport";
import { EDGE_ZONE_FRACTION, EDGE_ZONE_PX } from "../../types/editor";

/** The deep-readonly note a snapshot hands out (SS13). */
export type RONote = Immutable<Note>;

/** MIDI pitch range, frozen by the format. */
export const MIN_PITCH = 0;
export const MAX_PITCH = 127;
export const PITCH_COUNT = MAX_PITCH - MIN_PITCH + 1;

/** Time ruler strip at the top of the editor. */
export const RULER_HEIGHT_PX = 20;

/** SS10's "velocity lane (bottom strip)". */
export const VELOCITY_LANE_HEIGHT_PX = 72;

/** Padding above the tallest stalk so velocity 127 is still grabbable. */
export const VELOCITY_LANE_PAD_PX = 4;

/** Grab tolerance either side of a stalk (stalks are 1-2 px wide). */
export const VELOCITY_STALK_HIT_PX = 4;

/** The note grid never shrinks below this, however small the editor gets. */
export const MIN_NOTE_AREA_PX = 40;

/** Pointer travel for a full 1..127 sweep in `Alt`+body velocity mode. */
export const VELOCITY_DRAG_RANGE_PX = 160;

/** Hit tolerance around a note rectangle, so 1-px notes stay clickable. */
export const NOTE_HIT_SLOP_PX = 2;

export interface PianoRollLayoutOptions {
  rulerHeightPx?: number | undefined;
  velocityLaneHeightPx?: number | undefined;
}

/**
 * A LIVE view of the vertical stack: every member is a getter over the
 * viewport's current height, so nothing has to be re-wired on resize.
 */
export interface PianoRollLayout {
  readonly rulerHeightPx: number;
  readonly velocityLaneHeightPx: number;
  /** Top of the note grid (= bottom of the ruler). */
  readonly noteTopPx: number;
  /** Bottom of the note grid (= top of the velocity lane). */
  readonly noteBottomPx: number;
  readonly velocityTopPx: number;
  readonly velocityBottomPx: number;
}

export function createPianoRollLayout(
  viewport: Viewport,
  options: PianoRollLayoutOptions = {},
): PianoRollLayout {
  const ruler = Math.max(0, options.rulerHeightPx ?? RULER_HEIGHT_PX);
  const lane = Math.max(0, options.velocityLaneHeightPx ?? VELOCITY_LANE_HEIGHT_PX);

  const laneHeight = (): number => {
    const room = viewport.heightPx - ruler - MIN_NOTE_AREA_PX;
    return Math.max(0, Math.min(lane, room));
  };

  return {
    get rulerHeightPx(): number {
      return ruler;
    },
    get velocityLaneHeightPx(): number {
      return laneHeight();
    },
    get noteTopPx(): number {
      return ruler;
    },
    get noteBottomPx(): number {
      return Math.max(ruler, viewport.heightPx - laneHeight());
    },
    get velocityTopPx(): number {
      return Math.max(ruler, viewport.heightPx - laneHeight());
    },
    get velocityBottomPx(): number {
      return Math.max(ruler, viewport.heightPx);
    },
  };
}

// --- rows and pitches -------------------------------------------------------

/** The frozen row convention (SS9): `row = 127 - pitch`, rows go DOWN. */
export function rowOfPitch(pitch: number): Row {
  return MAX_PITCH - pitch;
}

export function pitchOfRow(row: Row): number {
  return MAX_PITCH - Math.floor(row);
}

export function clampPitch(pitch: number): number {
  return pitch < MIN_PITCH ? MIN_PITCH : pitch > MAX_PITCH ? MAX_PITCH : Math.round(pitch);
}

export function clampVelocity(vel: number): number {
  return vel < 1 ? 1 : vel > 127 ? 127 : Math.round(vel);
}

/** y (editor pixels) -> fractional row, ruler offset removed. */
export function rowAtY(viewport: Viewport, layout: PianoRollLayout, yPx: number): Row {
  return viewport.rowAt(yPx - layout.noteTopPx);
}

/** Row -> y of the row's TOP edge, ruler offset applied. */
export function yOfRow(viewport: Viewport, layout: PianoRollLayout, row: Row): number {
  return viewport.yOf(row) + layout.noteTopPx;
}

export function pitchAtY(viewport: Viewport, layout: PianoRollLayout, yPx: number): number {
  return clampPitch(pitchOfRow(rowAtY(viewport, layout, yPx)));
}

export function yOfPitch(viewport: Viewport, layout: PianoRollLayout, pitch: number): number {
  return yOfRow(viewport, layout, rowOfPitch(pitch));
}

/**
 * Rows increase downward and pitch increases upward, so a drag of `+n` rows
 * is a transpose of `-n` semitones. Rounded ONCE, on the total delta.
 */
export function pitchDeltaOfRows(deltaRows: number): number {
  const delta = -Math.round(deltaRows);
  // Fold `-0`, the way the kit's viewport does: a transpose of `-0` would
  // compare unequal to `0` in every "did anything move?" check.
  return delta === 0 ? 0 : delta;
}

// --- zones ------------------------------------------------------------------

export function isInRuler(layout: PianoRollLayout, yPx: number): boolean {
  return yPx < layout.noteTopPx;
}

export function isInVelocityLane(layout: PianoRollLayout, yPx: number): boolean {
  return layout.velocityLaneHeightPx > 0 && yPx >= layout.velocityTopPx;
}

export function isInNoteArea(layout: PianoRollLayout, yPx: number): boolean {
  return !isInRuler(layout, yPx) && !isInVelocityLane(layout, yPx);
}

// --- note rectangles --------------------------------------------------------

export interface NoteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function noteRect(
  viewport: Viewport,
  layout: PianoRollLayout,
  note: { readonly start: Ticks; readonly dur: Ticks; readonly pitch: number },
): NoteRect {
  const x = viewport.xOf(note.start);
  const w = note.dur * viewport.pxPerTick;
  return {
    x,
    y: yOfPitch(viewport, layout, note.pitch),
    w,
    h: viewport.pxPerRow,
  };
}

/**
 * SS10, verbatim: "Left/right edge zones: `min(6 px, 40% of note width)` each
 * side, so short notes always keep a grabbable body."
 */
export function edgeZonePx(noteWidthPx: number): number {
  return Math.min(EDGE_ZONE_PX, EDGE_ZONE_FRACTION * Math.max(0, noteWidthPx));
}

// --- the velocity lane ------------------------------------------------------

/** Lane y -> velocity: the lane top is 127, the lane bottom is 1. */
export function velocityAtY(layout: PianoRollLayout, yPx: number): number {
  const top = layout.velocityTopPx + VELOCITY_LANE_PAD_PX;
  const bottom = layout.velocityBottomPx;
  const span = bottom - top;
  if (span <= 0) return 1;
  const fraction = (bottom - yPx) / span;
  return clampVelocity(1 + fraction * 126);
}

/** Velocity -> the y of the top of its stalk (the inverse of `velocityAtY`). */
export function yOfVelocity(layout: PianoRollLayout, vel: number): number {
  const top = layout.velocityTopPx + VELOCITY_LANE_PAD_PX;
  const bottom = layout.velocityBottomPx;
  const span = bottom - top;
  if (span <= 0) return bottom;
  return bottom - ((clampVelocity(vel) - 1) / 126) * span;
}

/** x of a note's stalk in the velocity lane (stalks stand at note starts). */
export function stalkX(viewport: Viewport, note: { readonly start: Ticks }): number {
  return viewport.xOf(note.start);
}
