// SS10 — the piano roll: "the heart of the app, and where the previous attempt
// bled", as a skin over the SS9 canvas editor kit.
//
// What lives here, and the section that fixes each:
//   layout.ts       SS10 geometry: rows, edge zones, the velocity lane
//   hits.ts         SS10 "Hit zones" — the whole table as pure functions
//   context.ts      SS9  the scene an editor supplies (ephemeral state only)
//   preview.ts      SS9  one preview union; ghosts live in the overlay
//   dragMove.ts     SS10 `DragMove` + `DragDup` (and Alt+vertical velocity)
//   dragResize.ts   SS10 `DragResizeL` / `DragResizeR`
//   dragMarquee.ts  SS10 `Marquee` + the `Pending` click/dbl-click rows
//   dragVelocity.ts SS10 `DragVel`
//   dragPaint.ts    SS10 `Paint` (+ the ruler scrub the shell seeks with)
//   keymap.ts       SS10 the keyboard map, driving the SAME commands
//   layers.ts       SS9  grid / content / overlay, culled by binary search
//   pianoRoll.ts    SS10 all of the above, mounted as a `PianoRollView`
//
// Nothing here writes to the document outside a `commit`/`click`/key outcome:
// one gesture is one command is one undo entry (SS13).

export {
  createPianoRoll,
  createdNoteIds,
  redrawScopeOf,
  DEFAULT_ROW_HEIGHT_PX,
} from "./pianoRoll";
export type { PianoRollViewOptions, RedrawScope } from "./pianoRoll";

export { createPianoRollContext } from "./context";
export type { ContextRef, PianoRollContext, PianoRollContextOptions } from "./context";

export {
  createPianoRollLayout,
  clampPitch,
  clampVelocity,
  edgeZonePx,
  isInNoteArea,
  isInRuler,
  isInVelocityLane,
  noteRect,
  pitchAtY,
  pitchDeltaOfRows,
  pitchOfRow,
  rowAtY,
  rowOfPitch,
  stalkX,
  velocityAtY,
  yOfPitch,
  yOfRow,
  yOfVelocity,
  MAX_PITCH,
  MIN_PITCH,
  MIN_NOTE_AREA_PX,
  NOTE_HIT_SLOP_PX,
  PITCH_COUNT,
  RULER_HEIGHT_PX,
  VELOCITY_DRAG_RANGE_PX,
  VELOCITY_LANE_HEIGHT_PX,
  VELOCITY_LANE_PAD_PX,
  VELOCITY_STALK_HIT_PX,
} from "./layout";
export type { NoteRect, PianoRollLayout, PianoRollLayoutOptions, RONote } from "./layout";

export {
  CURSORS,
  createPianoRollHitTester,
  hitTestPianoRoll,
  isNoteHit,
  noteAtPoint,
  stalkAtPoint,
  zoneOfNoteX,
} from "./hits";
export type {
  PianoRollEmptyHit,
  PianoRollHit,
  PianoRollNoteHit,
  PianoRollZone,
} from "./hits";

export { HANDLER_IDS, ghostsOf } from "./preview";
export type {
  DupPreview,
  GhostNote,
  MarqueePreview,
  MovePreview,
  PaintPreview,
  PianoRollPreview,
  RectPx,
  ResizePreview,
  SeekPreview,
  VelocityPreview,
} from "./preview";

export { createPianoRollDragHandlers } from "./handlers";
export { createDupDragHandler, createMoveDragHandler } from "./dragMove";
export { createResizeDragHandler, createResizeDragHandlers, resizedSpan } from "./dragResize";
export type { ResizeEdge } from "./dragResize";
export { createMarqueeDragHandler, notesInRect } from "./dragMarquee";
export { createVelocityDragHandler } from "./dragVelocity";
export { createPaintDragHandler, createSeekDragHandler } from "./dragPaint";

export { clampGroupDelta, dragTargets, ghostOf, idsOf } from "./dragCommon";
export { createPianoRollKeyBinding, duplicateDelta } from "./keymap";
export type { PianoRollKeymapOptions } from "./keymap";
export { createKeyboardAudition, KEY_AUDITION_HOLD_MS } from "./audition";
export type { AuditionNote, KeyboardAudition, KeyboardAuditionOptions } from "./audition";

export {
  createPianoRollContentLayer,
  createPianoRollGridLayer,
  createPianoRollLayers,
  createPianoRollOverlayLayer,
} from "./layers";
export type { PianoRollLayersOptions, PianoRollOverlayOptions } from "./layers";
export { DEFAULT_PIANO_ROLL_THEME } from "./theme";
export type { PianoRollTheme } from "./theme";
