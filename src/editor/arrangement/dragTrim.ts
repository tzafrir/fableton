// SS10's `DragResizeL/R`, arrangement flavour: drag a clip's left or right
// edge zone to trim or extend it. One `trimClips` command per gesture, with
// ABSOLUTE spans — the FSM already computed the ghost geometry, so the
// command does not have to re-derive it (types/commands).
//
// The left edge is the interesting one: note ticks are clip-relative, so
// moving it rewrites note starts and drops content pushed outside the window
// (the accepted v1 loss; undo restores it exactly).

import type { Command } from "../../types/commands";
import type { ClickInfo, DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import type { LayerFrame } from "../../types/render";
import type { Ticks } from "../../types/time";
import type { ClipSpan } from "../../types/commands";
import type { ClipId } from "../../types/ids";
import { applySelectionClick, snapMoveDelta } from "../kit";
import type { ArrangementTheme } from "./constants";
import type { ArrangementContext } from "./context";
import type { ClipGhost, TrimEdge } from "./edits";
import { dragTargets, trimClips } from "./edits";
import { drawGhosts } from "./ghosts";
import type { ArrangementHit } from "./hits";

export interface TrimPreview {
  readonly edge: TrimEdge;
  readonly ghosts: readonly ClipGhost[];
  readonly spans: readonly ClipSpan[];
  readonly deltaTicks: Ticks;
}

export const TRIM_HANDLER_ID = "arrangement.trim";

export function createTrimDragHandler(
  context: ArrangementContext,
  theme: ArrangementTheme,
): DragHandler<ArrangementHit, TrimPreview> {
  const edgeOf = (start: GestureStart<ArrangementHit>): TrimEdge =>
    start.hit.kind === "clip" && start.hit.zone === "edgeL" ? "start" : "end";

  const previewOf = (start: GestureStart<ArrangementHit>, deltaTicks: Ticks): TrimPreview => {
    const edge = edgeOf(start);
    const clips =
      start.hit.kind === "clip"
        ? dragTargets(context.scene, start.hit.clipId, context.selection.ids())
        : [];
    const result = trimClips(context.scene, clips, edge, deltaTicks);
    return { edge, ghosts: result.ghosts, spans: result.spans, deltaTicks: result.delta };
  };

  /** As in `dragMove`: `Esc` restores the selection `begin` replaced. */
  let baseSelection: readonly ClipId[] = [];

  return {
    id: TRIM_HANDLER_ID,
    priority: 20,
    cursor: "ew-resize",

    claim(start: GestureStart<ArrangementHit>): boolean {
      return (
        start.button === 0 &&
        start.hit.kind === "clip" &&
        (start.hit.zone === "edgeL" || start.hit.zone === "edgeR")
      );
    },

    begin(start: GestureStart<ArrangementHit>): TrimPreview {
      baseSelection = context.selection.ids();
      if (start.hit.kind === "clip" && !context.selection.has(start.hit.clipId)) {
        context.selection.set([start.hit.clipId]);
      }
      return previewOf(start, 0);
    },

    update(update: DragUpdate<ArrangementHit, TrimPreview>): TrimPreview {
      // SS10: "Resize snaps the moving edge, never the anchored one" — the
      // delta is snapped, so the anchored edge cannot drift.
      return previewOf(update.start, snapMoveDelta(update.grid, update.deltaTicks, update.modifiers));
    },

    commit(update: DragUpdate<ArrangementHit, TrimPreview>): Command | null {
      const { spans, deltaTicks } = update.preview;
      if (deltaTicks === 0 || spans.length === 0) return null;
      return context.commands.trimClips(spans);
    },

    cancel(): void {
      // Ghosts only; nothing to undo — beyond the selection `begin` replaced.
      context.selection.set(baseSelection);
    },

    click(start: GestureStart<ArrangementHit>, info: ClickInfo): Command | null {
      if (start.hit.kind !== "clip") return null;
      applySelectionClick(context.selection, start.hit.clipId, info.modifiers);
      return null;
    },

    drawPreview(frame: LayerFrame, preview: TrimPreview): void {
      drawGhosts(frame, theme, preview.ghosts);
    },
  };
}
