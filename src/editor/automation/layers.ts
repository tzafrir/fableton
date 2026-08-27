// SS9's three layers, automation skin. Split out of `view.ts` for the same
// reason the piano roll's are: a layer that takes a context and a frame is a
// pure function of the document + viewport, so `layers.test.ts` can read what
// it drew off the kit's recording 2D context (SS15) — including the one
// property SS9 insists on, that a frame costs O(VISIBLE) points, not O(all).

import type { AutoPoint, EditorLayer, LayerFrame } from "../../types";
import { bendShape } from "../../engine/automation/curve";
import { segmentModeOf, type AutomationLaneContext } from "./context";
import type { LanePreview } from "./handlers";
import { LANE_PAD_PX, POINT_RADIUS_PX, yOfValue } from "./layout";
import { segmentIndexAt, visiblePointRange } from "./points";

export const AUTOMATION_THEME = {
  line: "#5aa9e6",
  point: "#ddeeff",
  pointSelected: "#f2c14e",
  ghost: "rgba(242, 193, 78, 0.8)",
  marquee: "rgba(120, 160, 255, 0.16)",
  marqueeBorder: "rgba(120, 160, 255, 0.7)",
  gridLine: "#24262c",
  laneBound: "#333",
} as const;

/** Bars + the lane's value bounds. Viewport changes only (SS9). */
export function createAutomationGridLayer(ctx: AutomationLaneContext): EditorLayer {
  return {
    kind: "grid",
    draw(frame: LayerFrame): void {
      const { ctx: g, viewport, widthPx, heightPx } = frame;
      const barTicks = ctx.grid.gridTicks() * 4;
      g.strokeStyle = AUTOMATION_THEME.gridLine;
      g.lineWidth = 1;
      const first = Math.floor(viewport.tAt(0) / barTicks) * barTicks;
      for (let t = first; viewport.xOf(t) <= widthPx; t += barTicks) {
        const x = Math.round(viewport.xOf(t)) + 0.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, heightPx);
        g.stroke();
      }
      g.strokeStyle = AUTOMATION_THEME.laneBound;
      for (const y of [LANE_PAD_PX, heightPx - LANE_PAD_PX]) {
        g.beginPath();
        g.moveTo(0, Math.round(y) + 0.5);
        g.lineTo(widthPx, Math.round(y) + 0.5);
        g.stroke();
      }
    },
  };
}

/** The curve and its point markers. */
export function createAutomationContentLayer(ctx: AutomationLaneContext): EditorLayer {
  return {
    kind: "content",
    draw(frame: LayerFrame): void {
      const desc = ctx.desc();
      if (desc === null) return;
      const { ctx: g, viewport, widthPx, heightPx } = frame;
      const pts = ctx.points();
      if (pts.length === 0) return;
      const discrete = segmentModeOf(desc) === "hold";
      // SS9: "Content culls to the viewport ... O(visible) per frame." The
      // window's neighbours come along, so the segments crossing the left and
      // right edges are still drawn from their off-screen endpoints.
      const visible = viewport.visibleTicks();
      const range = visiblePointRange(pts, visible.start, visible.end);

      g.strokeStyle = AUTOMATION_THEME.line;
      g.lineWidth = 1.5;
      g.beginPath();
      const head = pts[range.start] as AutoPoint;
      // A lane holds its edges (curve.ts): the flat lead-in is drawn only when
      // the first point is the one actually in view.
      g.moveTo(range.start === 0 ? 0 : viewport.xOf(head.t), yOfValue(desc, head.v, heightPx));
      for (let i = range.start; i < range.end; i++) {
        const a = pts[i] as AutoPoint;
        const ax = viewport.xOf(a.t);
        const ay = yOfValue(desc, a.v, heightPx);
        g.lineTo(ax, ay);
        const b = pts[i + 1];
        if (b === undefined) {
          g.lineTo(widthPx, ay); // flat trail past the last point
          break;
        }
        if (i + 1 >= range.end) break; // the rest of the lane is off-screen right
        const bx = viewport.xOf(b.t);
        const by = yOfValue(desc, b.v, heightPx);
        if (discrete) {
          // SS11: stepped/enum/toggle render as steps — and play as steps
          // (curve.ts `'hold'`), which is what makes the two agree.
          g.lineTo(bx, ay);
          g.lineTo(bx, by);
        } else if (a.curve === 0) {
          g.lineTo(bx, by);
        } else {
          const steps = Math.max(4, Math.min(48, Math.round((bx - ax) / 4)));
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            g.lineTo(ax + (bx - ax) * t, ay + (by - ay) * bendShape(t, a.curve));
          }
        }
      }
      g.stroke();

      g.fillStyle = AUTOMATION_THEME.point;
      for (let i = range.start; i < range.end; i++) {
        const p = pts[i] as AutoPoint;
        g.beginPath();
        g.arc(viewport.xOf(p.t), yOfValue(desc, p.v, heightPx), POINT_RADIUS_PX, 0, Math.PI * 2);
        g.fill();
      }
    },
  };
}

/** Selection rings and the live gesture's ghosts — the only layer allowed to
 *  redraw every frame of a drag (SS9). */
export function createAutomationOverlayLayer(
  ctx: AutomationLaneContext,
  preview: () => LanePreview | null,
): EditorLayer {
  return {
    kind: "overlay",
    draw(frame: LayerFrame): void {
      const desc = ctx.desc();
      if (desc === null) return;
      const { ctx: g, viewport, heightPx } = frame;
      const pts = ctx.points();

      // Selection rings — culled like the content they sit on.
      const visible = viewport.visibleTicks();
      const range = visiblePointRange(pts, visible.start, visible.end);
      g.strokeStyle = AUTOMATION_THEME.pointSelected;
      g.lineWidth = 2;
      for (let i = range.start; i < range.end; i++) {
        const p = pts[i] as AutoPoint;
        if (!ctx.selection.has(p.t)) continue;
        g.beginPath();
        g.arc(viewport.xOf(p.t), yOfValue(desc, p.v, heightPx), POINT_RADIUS_PX + 2, 0, Math.PI * 2);
        g.stroke();
      }

      const live = preview();
      if (live === null) return;
      if (live.kind === "move") {
        g.fillStyle = AUTOMATION_THEME.ghost;
        for (const ghost of live.ghosts) {
          g.beginPath();
          g.arc(
            viewport.xOf(ghost.toT),
            yOfValue(desc, ghost.v, heightPx),
            POINT_RADIUS_PX,
            0,
            Math.PI * 2,
          );
          g.fill();
        }
        return;
      }
      if (live.kind === "bend") {
        // Ghost curve for the bent segment (binary search, not a scan: this
        // runs every frame of the drag).
        const i = segmentIndexAt(pts, live.startT);
        const a = pts[i];
        const b = pts[i + 1];
        if (a === undefined || b === undefined || a.t !== live.startT) return;
        g.strokeStyle = AUTOMATION_THEME.ghost;
        g.lineWidth = 1.5;
        g.beginPath();
        const ax = viewport.xOf(a.t);
        const ay = yOfValue(desc, a.v, heightPx);
        const bx = viewport.xOf(b.t);
        const by = yOfValue(desc, b.v, heightPx);
        g.moveTo(ax, ay);
        const steps = 32;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          g.lineTo(ax + (bx - ax) * t, ay + (by - ay) * bendShape(t, live.curve));
        }
        g.stroke();
        return;
      }
      const [x0, x1] = [Math.min(live.x0, live.x1), Math.max(live.x0, live.x1)];
      const [y0, y1] = [Math.min(live.y0, live.y1), Math.max(live.y0, live.y1)];
      g.fillStyle = AUTOMATION_THEME.marquee;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = AUTOMATION_THEME.marqueeBorder;
      g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    },
  };
}
