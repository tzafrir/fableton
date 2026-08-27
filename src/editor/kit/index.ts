// SS9 — The canvas editor kit: the load-bearing seam every editor sits on.
//
//   "The arrangement lanes, piano roll, and automation lanes are three skins
//    over one framework. This is the answer to 'canvas fixed rendering but
//    editing was still painful': the kit owns coordinates, hit-testing,
//    gestures, and previews so each editor only supplies its scene and its
//    verbs."
//
// What lives here, and the SS section that fixes each:
//   viewport.ts      SS9  one transform per editor; zoom-to-cursor
//   grid.ts          SS10 adaptive/fixed/triplet grid; relative vs absolute snap
//   snapping.ts      SS10 the `Alt` bypass, written once
//   renderer.ts      SS9  4-layer stack, dirty flags on rAF, dpr + half pixels
//   playhead.ts      SS9  DOM playhead that never invalidates a canvas
//   tickIndex.ts     SS9  binary-search culling over start-sorted content
//   gestureEngine.ts SS9  the FSM: threshold, capture, preview, one command
//   overlayLayer.ts  SS9  the overlay that draws the active handler's ghosts
//   selection.ts     SS13 ephemeral selection; Shift adds / Ctrl toggles
//   host.ts          SS9  all of the above, wired
//
// Nothing in this directory imports a document type beyond `Command` and
// `DocumentStore`: the kit is generic over what an editor edits.

export { createViewport, DEFAULT_VIEWPORT_LIMITS, DEFAULT_PX_PER_TICK, DEFAULT_PX_PER_ROW } from "./viewport";
export { createGrid, DEFAULT_GRID_SETTINGS, ADAPTIVE_MIN_GRID_PX } from "./grid";
export type { GridOptions } from "./grid";
export { snapBypassed, snapCreateTick, snapMoveDelta } from "./snapping";

export { createRenderer, alignHalfPixel, alignPixel, LAYER_ORDER } from "./renderer";
export { createPlayheadView } from "./playhead";
export type { PlayheadOptions } from "./playhead";
export { createTickIndex } from "./tickIndex";
export { createGestureOverlayLayer } from "./overlayLayer";
export type { GestureOverlayOptions } from "./overlayLayer";

export {
  createGestureEngine,
  createKitGestureEngine,
  DEFAULT_CURSOR,
  ZOOM_WHEEL_SENSITIVITY,
} from "./gestureEngine";
export type { KitGestureEngine } from "./gestureEngine";

export { createSelectionModel, applySelectionClick } from "./selection";
export { createEditorHost } from "./host";
export type { KitEditorHost } from "./host";

export {
  createClickCounter,
  editorPointOf,
  elementPointOf,
  isApplePlatform,
  keyInputOf,
  modifiers,
  modifiersOf,
  MULTI_CLICK_MS,
  MULTI_CLICK_SLOP_PX,
  NO_MODIFIERS,
  pointerInputOf,
  setApplePlatform,
  wheelInputOf,
} from "./points";
export type { ClickCounter } from "./points";

// Re-exported so editors import the frozen constants from one place.
export { DRAG_THRESHOLD_PX } from "../../types/gesture";
export {
  DEFAULT_NOTE_VELOCITY,
  EDGE_ZONE_FRACTION,
  EDGE_ZONE_PX,
  FINE_NUDGE_TICKS,
  MIN_CLIP_TICKS,
  MIN_NOTE_TICKS,
} from "../../types/editor";
