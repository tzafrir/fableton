// `arrangement` (SS18-M1) — the arrangement lanes as a KIT SKIN.
//
//   "The arrangement lanes, piano roll, and automation lanes are three skins
//    over one framework ... each editor only supplies its scene and its
//    verbs." (SS9)
//
// This package supplies exactly that and nothing else:
//
//   scene.ts     the document, indexed per lane for O(visible) culling (SS9)
//   geometry.ts  clips <-> pixels, and SS10's edge zones, in one place
//   hits.ts      the hover model: which clip, which zone
//   edits.ts     the verb math (clamps, ghosts, command payloads), pure
//   drag*.ts     the verbs: move / duplicate, trim, create, loop brace, marquee
//   keys.ts      the keyboard, a first-class client of the same commands
//   layers.ts    grid / content drawing; ghosts.ts draws the overlay
//   ruler.ts     SS8's second (and only other) tick->seconds conversion site
//   headers.ts   one bounded-count DOM row per channel
//   arrangement.ts  all of the above wired to the kit host and the store
//
// Everything above the drag handlers is a pure function of the document and
// the viewport, so the whole FSM is exercised headlessly in the tests.

export { createArrangement, createArrangementView, createdClipIds } from "./arrangement";
export type { ArrangementViewOptions, KitArrangementView } from "./arrangement";

export { createArrangementScene, NO_CHANGE } from "./scene";
export type { ArrangementRow, ArrangementScene, SceneChange } from "./scene";

export {
  braceHeightPx,
  clipContainsTick,
  clipRect,
  clipSpanPx,
  edgeZonePx,
  laneRect,
  loopSpanTicks,
  spansOverlap,
  ZONE_CURSORS,
  zoneAt,
} from "./geometry";
export type { ClipView, ClipZone, Rect } from "./geometry";

export { createClipHitTester, createHitTesters, createLaneHitTester, isClipHit, isLaneHit } from "./hits";
export type { ArrangementClipHit, ArrangementHit, ArrangementLaneHit } from "./hits";

export {
  clampMoveDelta,
  clampRowDelta,
  clampTrimDelta,
  createSpan,
  defaultLoopFor,
  dragTargets,
  loopAfterDrag,
  moveGhosts,
  trimClips,
} from "./edits";
export type { ClipGhost, CreateSpan, TrimEdge, TrimResult } from "./edits";

export { createMoveDragHandler, MOVE_HANDLER_ID } from "./dragMove";
export type { MovePreview } from "./dragMove";
export { createTrimDragHandler, TRIM_HANDLER_ID } from "./dragTrim";
export type { TrimPreview } from "./dragTrim";
export { createCreateDragHandler, CREATE_HANDLER_ID } from "./dragCreate";
export type { CreatePreview } from "./dragCreate";
export { createLoopDragHandler, LOOP_HANDLER_ID } from "./dragLoop";
export type { LoopPart, LoopPreview } from "./dragLoop";
export { createMarqueeDragHandler, MARQUEE_HANDLER_ID } from "./dragMarquee";
export type { MarqueePreview } from "./dragMarquee";

export {
  createArrangementKeyBindings,
  KEY_BINDING_ID,
  splitSelectionAt,
  splittableClips,
  toggleLoopOnSelection,
} from "./keys";

export { createArrangementClipsLayer, createArrangementGridLayer, drawSelectionAndHover } from "./layers";
export type { LayerDeps, OverlayDeps } from "./layers";
export { drawClipOutline, drawGhosts, drawMarquee } from "./ghosts";

export { createRuler, formatSeconds, labelStepTicks } from "./ruler";
export type { RulerOptions, RulerView } from "./ruler";

export { createLaneHeaders } from "./headers";
export type { HeadersOptions, LaneHeadersView } from "./headers";

export type { ArrangementContext } from "./context";
export {
  CLIP_INSET_PX,
  CONTENT_TAIL_BARS,
  DEFAULT_LANE_HEIGHT_PX,
  DEFAULT_THEME,
  HEADER_WIDTH_PX,
  LOOP_BRACE_PX,
  LOOP_HANDLE_PX,
  RULER_HEIGHT_PX,
  resolveTheme,
} from "./constants";
export type { ArrangementTheme } from "./constants";
