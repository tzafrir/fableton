// SS9, assembled — "The arrangement lanes, piano roll, and automation lanes
// are three skins over one framework ... the kit owns coordinates,
// hit-testing, gestures, and previews so each editor only supplies its scene
// and its verbs."
//
// `EditorHost` IS that framework wired together: viewport + grid + renderer +
// gesture engine + DOM playhead, with the four connections that every editor
// would otherwise re-derive (and get subtly wrong):
//
//   viewport change   -> renderer invalidates (grid + content + overlay)
//   gesture preview   -> renderer invalidates OVERLAY ONLY
//   gesture commit    -> store.dispatch (exactly one command, SS13)
//   container resize  -> renderer.resize + viewport.setSize

import type { EditorHost, EditorHostOptions } from "../../types/editor";
import type { HitTarget } from "../../types/gesture";
import type { Grid, Viewport } from "../../types/viewport";
import type { PlayheadView, Renderer } from "../../types/render";
import { createViewport } from "./viewport";
import { createGrid } from "./grid";
import { createRenderer } from "./renderer";
import { createPlayheadView } from "./playhead";
import { createKitGestureEngine, type KitGestureEngine } from "./gestureEngine";

/** The kit's own widening of `EditorHost` (see `KitGestureEngine`). */
export interface KitEditorHost<THit extends HitTarget = HitTarget>
  extends EditorHost<THit> {
  readonly gestures: KitGestureEngine<THit>;
}

export function createEditorHost<THit extends HitTarget>(
  options: EditorHostOptions<THit>,
): KitEditorHost<THit> {
  const viewport: Viewport = createViewport(options.viewport);
  const grid: Grid = createGrid({ viewport, settings: options.grid });

  const renderer: Renderer = createRenderer({
    container: options.container,
    viewport,
    layers: options.layers,
    dpr: options.dpr,
  });

  const element = renderer.element;
  // SS10's keyboard map needs focus; the host owns that so no editor has to.
  element.tabIndex = 0;

  const playhead: PlayheadView = createPlayheadView({
    container: element,
    viewport,
  });

  const gestures = createKitGestureEngine<THit>({
    element,
    viewport,
    grid,
    dispatch: (command) => {
      options.store.dispatch(command);
    },
    // The ONLY layer a live gesture is allowed to dirty (SS9).
    invalidateOverlay: () => {
      renderer.invalidate("overlay");
    },
    hitTesters: options.hitTesters,
    dragHandlers: options.dragHandlers,
    keyBindings: options.keyBindings,
  });

  // An adaptive grid changes division under zoom: the grid layer must follow.
  const unsubscribeGrid = grid.onChange(() => {
    renderer.invalidate(["grid", "content"]);
  });

  const measure = (): void => {
    const rect = options.container.getBoundingClientRect();
    // jsdom and a display:none container both report 0; fall back to the
    // layout properties so headless tests still get a usable size.
    const width = rect.width || options.container.clientWidth;
    const height = rect.height || options.container.clientHeight;
    viewport.setSize(width, height);
    renderer.resize(width, height);
  };

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(options.container);
  }
  measure();

  let disposed = false;

  return {
    element,
    viewport,
    grid,
    renderer,
    gestures,
    playhead,
    focus(): void {
      element.focus();
    },
    measure,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      unsubscribeGrid();
      gestures.dispose();
      playhead.dispose();
      renderer.dispose();
    },
  };
}
