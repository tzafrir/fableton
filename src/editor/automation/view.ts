// SS11 — the automation lane editor: the canvas kit's THIRD skin.
//
// "Editing reuses the kit verbatim: click a segment to add a point, drag a
// point (snap on time axis only), drag a segment's middle to bend `curve`,
// marquee + the same keyboard nudges." One lane at a time is shown; the
// panel around it picks which (SS18-M3 note: the plan draws lanes as
// expandable rows inside the arrangement, but M1 froze the arrangement's
// row convention as `row = index in channelOrder`, so the lane editor lives
// in its own panel — same kit, same verbs, different placement. Recorded as
// a deliberate deviation.)
//
// Points carry no ids: gestures key them by their tick at gesture start,
// which is exactly what the SS11 lane commands take.

import type {
  AutoPoint,
  ClickInfo,
  Command,
  DocumentStore,
  DragHandler,
  DragUpdate,
  GestureStart,
  GridSettings,
  HitTester,
  KeyBinding,
  LaneId,
  LayerFrame,
  ParamDescriptor,
  ProjectCommands,
  Ticks,
  Unsub,
} from "../../types";
import { createEditorHost, type KitEditorHost } from "../kit/host";
import { snapBypassed } from "../kit/snapping";
import { bendShape, laneValueAt } from "../../engine/automation/curve";
import {
  BEND_DRAG_RANGE_PX,
  LANE_PAD_PX,
  POINT_HIT_PX,
  POINT_RADIUS_PX,
  SEGMENT_HIT_PX,
  valueAtY,
  yOfValue,
} from "./layout";

export interface AutomationLaneViewOptions {
  container: HTMLElement;
  store: DocumentStore;
  commands: ProjectCommands;
  grid?: Partial<GridSettings> | undefined;
  dpr?: number | undefined;
}

export interface AutomationLaneView {
  readonly element: HTMLElement;
  /** Which lane is shown; `desc` maps the value axis (null = greyed lane). */
  setLane(laneId: LaneId | null, desc: ParamDescriptor | null): void;
  setPlayheadTicks(tick: Ticks): void;
  focus(): void;
  dispose(): void;
}

// --- hits -------------------------------------------------------------------

interface PointHit {
  kind: "point";
  cursor?: string;
  t: Ticks;
}
interface SegmentHit {
  kind: "segment";
  cursor?: string;
  /** Tick of the point the segment STARTS at. */
  startT: Ticks;
}
interface EmptyHit {
  kind: "empty";
  cursor?: string;
}
type LaneHit = PointHit | SegmentHit | EmptyHit;

// --- previews ---------------------------------------------------------------

interface MovePreview {
  kind: "move";
  /** Original tick -> ghost position. */
  ghosts: { fromT: Ticks; toT: Ticks; v: number }[];
}
interface BendPreview {
  kind: "bend";
  startT: Ticks;
  curve: number;
}
interface MarqueePreview {
  kind: "marquee";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
type LanePreview = MovePreview | BendPreview | MarqueePreview;

const THEME = {
  line: "#5aa9e6",
  point: "#ddeeff",
  pointSelected: "#f2c14e",
  ghost: "rgba(242, 193, 78, 0.8)",
  marquee: "rgba(120, 160, 255, 0.16)",
  marqueeBorder: "rgba(120, 160, 255, 0.7)",
  gridLine: "#24262c",
  disabled: "#666",
} as const;

export function createAutomationLaneView(options: AutomationLaneViewOptions): AutomationLaneView {
  const { store, commands } = options;

  // --- mutable editor state (never document state, SS13) --------------------
  let laneId: LaneId | null = null;
  let desc: ParamDescriptor | null = null;
  let selection = new Set<Ticks>();
  let heightPx = 0;

  const points = (): readonly AutoPoint[] => {
    if (laneId === null) return [];
    return (store.getState().lanes[laneId]?.points ?? []) as readonly AutoPoint[];
  };

  // --- hit testing -----------------------------------------------------------

  const hitTester: HitTester<LaneHit> = {
    id: "automation.zones",
    hitTest(point): LaneHit | null {
      if (desc === null || laneId === null) return null;
      const d = desc;
      const pts = points();
      // Point markers first.
      for (const p of pts) {
        const px = host.viewport.xOf(p.t);
        const py = yOfValue(d, p.v, heightPx);
        if (Math.abs(px - point.xPx) <= POINT_HIT_PX && Math.abs(py - point.yPx) <= POINT_HIT_PX) {
          return { kind: "point", cursor: "grab", t: p.t };
        }
      }
      // Then the curve itself.
      if (pts.length > 0) {
        const value = laneValueAt(pts, point.tick);
        if (value !== undefined && Math.abs(yOfValue(d, value, heightPx) - point.yPx) <= SEGMENT_HIT_PX) {
          let startT = pts[0]?.t ?? 0;
          for (const p of pts) {
            if (p.t <= point.tick) startT = p.t;
            else break;
          }
          return { kind: "segment", cursor: "copy", startT };
        }
      }
      return { kind: "empty" };
    },
  };

  // --- drag: move points -----------------------------------------------------

  const moveHandler: DragHandler<LaneHit, MovePreview> = {
    id: "automation.move",
    priority: 20,
    cursor: "grabbing",
    claim: (start) => start.button === 0 && start.hit.kind === "point",
    begin(start): MovePreview {
      const hit = start.hit as PointHit;
      if (!selection.has(hit.t)) {
        selection = start.modifiers.shift ? new Set([...selection, hit.t]) : new Set([hit.t]);
        host.renderer.invalidate("overlay");
      }
      const targets = points().filter((p) => selection.has(p.t));
      return { kind: "move", ghosts: targets.map((p) => ({ fromT: p.t, toT: p.t, v: p.v })) };
    },
    update(update): MovePreview {
      const d = desc as ParamDescriptor;
      const all = points();
      const deltaT = snapBypassed(update.modifiers)
        ? update.deltaTicks
        : update.start.grid.snapDelta(update.deltaTicks);
      const deltaY = update.point.yPx - update.start.point.yPx;
      const ghosts = update.preview.ghosts.map((g) => {
        const original = all.find((p) => p.t === g.fromT);
        const v0 = original?.v ?? g.v;
        const y0 = yOfValue(d, v0, heightPx);
        return {
          fromT: g.fromT,
          toT: Math.max(0, g.fromT + deltaT),
          v: valueAtY(d, y0 + deltaY, heightPx),
        };
      });
      return { kind: "move", ghosts };
    },
    commit(update): Command | null {
      if (laneId === null) return null;
      const moved = update.preview.ghosts.filter(
        (g) => g.fromT !== g.toT || g.v !== points().find((p) => p.t === g.fromT)?.v,
      );
      if (moved.length === 0) return null;
      selection = new Set(moved.map((g) => g.toT));
      return commands.moveLanePoints(laneId, moved);
    },
    cancel(): void {
      // Preview only — zero document traffic.
    },
    click(start: GestureStart<LaneHit>, info: ClickInfo): Command | null {
      const hit = start.hit as PointHit;
      if (info.clickCount >= 2 && laneId !== null) {
        // Double-click a point: delete it (the fast way out).
        selection.delete(hit.t);
        return commands.deleteLanePoints(laneId, [hit.t]);
      }
      if (info.modifiers.shift) {
        if (selection.has(hit.t)) selection.delete(hit.t);
        else selection.add(hit.t);
      } else {
        selection = new Set([hit.t]);
      }
      host.renderer.invalidate("overlay");
      return null;
    },
  };

  // --- drag: bend a segment --------------------------------------------------

  const bendHandler: DragHandler<LaneHit, BendPreview> = {
    id: "automation.bend",
    priority: 10,
    cursor: "ns-resize",
    claim: (start) => start.button === 0 && start.hit.kind === "segment",
    begin(start): BendPreview {
      const hit = start.hit as SegmentHit;
      const current = points().find((p) => p.t === hit.startT)?.curve ?? 0;
      return { kind: "bend", startT: hit.startT, curve: current };
    },
    update(update: DragUpdate<LaneHit, BendPreview>): BendPreview {
      const hit = update.start.hit as SegmentHit;
      const base = points().find((p) => p.t === hit.startT)?.curve ?? 0;
      // Dragging DOWN eases in (positive bend) for a rising segment; keep the
      // simpler invariant: down = +curve.
      const curve = Math.min(1, Math.max(-1, base + update.deltaPx.y / (BEND_DRAG_RANGE_PX / 2)));
      return { kind: "bend", startT: hit.startT, curve };
    },
    commit(update): Command | null {
      if (laneId === null) return null;
      const before = points().find((p) => p.t === update.preview.startT)?.curve ?? 0;
      if (update.preview.curve === before) return null;
      return commands.setLaneSegmentCurve(laneId, update.preview.startT, update.preview.curve);
    },
    cancel(): void {
      // Preview only.
    },
    click(start: GestureStart<LaneHit>): Command | null {
      // SS11: "click a segment to add a point".
      if (laneId === null || desc === null) return null;
      const t = start.grid.snap(start.point.tick);
      const v = valueAtY(desc, start.point.yPx, heightPx);
      selection = new Set([Math.max(0, t)]);
      return commands.addLanePoint(laneId, { t: Math.max(0, t), v });
    },
  };

  // --- drag: marquee on empty ------------------------------------------------

  const marqueeHandler: DragHandler<LaneHit, MarqueePreview> = {
    id: "automation.marquee",
    priority: 0,
    cursor: "crosshair",
    claim: (start) => start.button === 0 && start.hit.kind === "empty",
    begin(start): MarqueePreview {
      return { kind: "marquee", x0: start.point.xPx, y0: start.point.yPx, x1: start.point.xPx, y1: start.point.yPx };
    },
    update(update): MarqueePreview {
      const p = update.preview;
      const next = { ...p, x1: update.point.xPx, y1: update.point.yPx };
      const d = desc;
      if (d !== null) {
        const [x0, x1] = [Math.min(next.x0, next.x1), Math.max(next.x0, next.x1)];
        const [y0, y1] = [Math.min(next.y0, next.y1), Math.max(next.y0, next.y1)];
        selection = new Set(
          points()
            .filter((pt) => {
              const px = host.viewport.xOf(pt.t);
              const py = yOfValue(d, pt.v, heightPx);
              return px >= x0 && px <= x1 && py >= y0 && py <= y1;
            })
            .map((pt) => pt.t),
        );
      }
      return next;
    },
    commit(): Command | null {
      return null; // selection is not undoable (SS10/SS13)
    },
    cancel(): void {
      selection = new Set();
    },
    click(start: GestureStart<LaneHit>, info: ClickInfo): Command | null {
      // Empty area: a click clears; a DOUBLE-click starts the lane's first
      // point (there is no segment to click on an empty lane).
      if (info.clickCount >= 2 && laneId !== null && desc !== null) {
        const t = Math.max(0, start.grid.snap(start.point.tick));
        const v = valueAtY(desc, start.point.yPx, heightPx);
        selection = new Set([t]);
        return commands.addLanePoint(laneId, { t, v });
      }
      selection = new Set();
      host.renderer.invalidate("overlay");
      return null;
    },
  };

  // --- keyboard (SS11: "the same keyboard nudges") ---------------------------

  const keys: KeyBinding = {
    id: "automation.keys",
    handle(input) {
      if (laneId === null || desc === null) return null;
      const d = desc;
      const id = laneId;
      const selected = points().filter((p) => selection.has(p.t));
      if (input.key === "Delete" || input.key === "Backspace") {
        if (selected.length === 0) return { command: null };
        selection = new Set();
        return { command: commands.deleteLanePoints(id, selected.map((p) => p.t)) };
      }
      if (selected.length === 0) return null;
      const nudge = (dt: Ticks, dn: number): Command => {
        const edits = selected.map((p) => {
          const y = yOfValue(d, p.v, heightPx);
          const span = Math.max(1, heightPx - LANE_PAD_PX * 2);
          return {
            fromT: p.t,
            toT: Math.max(0, p.t + dt),
            v: dn === 0 ? p.v : valueAtY(d, y - dn * span, heightPx),
          };
        });
        selection = new Set(edits.map((e) => e.toT));
        return commands.moveLanePoints(id, edits);
      };
      const gridTicks = host.grid.gridTicks();
      switch (input.key) {
        case "ArrowLeft":
          return { command: nudge(input.modifiers.shift ? -60 : -gridTicks, 0) };
        case "ArrowRight":
          return { command: nudge(input.modifiers.shift ? 60 : gridTicks, 0) };
        case "ArrowUp":
          return { command: nudge(0, input.modifiers.shift ? 0.002 : 0.02) };
        case "ArrowDown":
          return { command: nudge(0, input.modifiers.shift ? -0.002 : -0.02) };
        default:
          return null;
      }
    },
  };

  // --- layers ----------------------------------------------------------------

  function drawGridLayer(frame: LayerFrame): void {
    const { ctx, viewport, widthPx, heightPx: h } = frame;
    const barTicks = host.grid.gridTicks() * 4;
    ctx.strokeStyle = THEME.gridLine;
    ctx.lineWidth = 1;
    const first = Math.floor(viewport.tAt(0) / barTicks) * barTicks;
    for (let t = first; viewport.xOf(t) <= widthPx; t += barTicks) {
      const x = Math.round(viewport.xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    // Lane bounds.
    ctx.strokeStyle = "#333";
    for (const y of [LANE_PAD_PX, h - LANE_PAD_PX]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(widthPx, Math.round(y) + 0.5);
      ctx.stroke();
    }
  }

  function drawContentLayer(frame: LayerFrame): void {
    const d = desc;
    if (d === null) return;
    const { ctx, viewport, widthPx } = frame;
    heightPx = frame.heightPx;
    const pts = points();
    if (pts.length === 0) return;
    const discrete = d.kind !== "continuous";

    ctx.strokeStyle = THEME.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const firstY = yOfValue(d, pts[0]?.v ?? 0, frame.heightPx);
    ctx.moveTo(0, firstY);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i] as AutoPoint;
      const ax = viewport.xOf(a.t);
      const ay = yOfValue(d, a.v, frame.heightPx);
      ctx.lineTo(ax, ay);
      const b = pts[i + 1];
      if (b === undefined) {
        ctx.lineTo(widthPx, ay);
        break;
      }
      const bx = viewport.xOf(b.t);
      const by = yOfValue(d, b.v, frame.heightPx);
      if (discrete) {
        // SS11: stepped/enum/toggle render as steps.
        ctx.lineTo(bx, ay);
        ctx.lineTo(bx, by);
      } else if (a.curve === 0) {
        ctx.lineTo(bx, by);
      } else {
        const steps = Math.max(4, Math.min(48, Math.round((bx - ax) / 4)));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const y = ay + (by - ay) * bendShape(t, a.curve);
          ctx.lineTo(ax + (bx - ax) * t, y);
        }
      }
    }
    ctx.stroke();

    for (const p of pts) {
      const x = viewport.xOf(p.t);
      const y = yOfValue(d, p.v, frame.heightPx);
      ctx.fillStyle = THEME.point;
      ctx.beginPath();
      ctx.arc(x, y, POINT_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawOverlayLayer(frame: LayerFrame): void {
    const d = desc;
    if (d === null) return;
    const { ctx, viewport } = frame;
    const preview = host.gestures.preview as LanePreview | null;

    // Selection rings.
    ctx.strokeStyle = THEME.pointSelected;
    ctx.lineWidth = 2;
    for (const p of points()) {
      if (!selection.has(p.t)) continue;
      ctx.beginPath();
      ctx.arc(viewport.xOf(p.t), yOfValue(d, p.v, frame.heightPx), POINT_RADIUS_PX + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (preview === null) return;
    if (preview.kind === "move") {
      ctx.fillStyle = THEME.ghost;
      for (const g of preview.ghosts) {
        ctx.beginPath();
        ctx.arc(viewport.xOf(g.toT), yOfValue(d, g.v, frame.heightPx), POINT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (preview.kind === "bend") {
      // Ghost curve for the bent segment.
      const pts = points();
      const i = pts.findIndex((p) => p.t === preview.startT);
      const a = pts[i];
      const b = pts[i + 1];
      if (a !== undefined && b !== undefined) {
        ctx.strokeStyle = THEME.ghost;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const ax = viewport.xOf(a.t);
        const ay = yOfValue(d, a.v, frame.heightPx);
        const bx = viewport.xOf(b.t);
        const by = yOfValue(d, b.v, frame.heightPx);
        ctx.moveTo(ax, ay);
        const steps = 32;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          ctx.lineTo(ax + (bx - ax) * t, ay + (by - ay) * bendShape(t, preview.curve));
        }
        ctx.stroke();
      }
    } else {
      const [x0, x1] = [Math.min(preview.x0, preview.x1), Math.max(preview.x0, preview.x1)];
      const [y0, y1] = [Math.min(preview.y0, preview.y1), Math.max(preview.y0, preview.y1)];
      ctx.fillStyle = THEME.marquee;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = THEME.marqueeBorder;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    }
  }

  // --- host ------------------------------------------------------------------

  const host: KitEditorHost<LaneHit> = createEditorHost<LaneHit>({
    container: options.container,
    store: options.store,
    layers: [
      { kind: "grid", draw: drawGridLayer },
      { kind: "content", draw: drawContentLayer },
      { kind: "overlay", draw: drawOverlayLayer },
    ],
    viewport: { pxPerTick: 0.05, pxPerRow: 16 },
    grid: options.grid,
    hitTesters: [hitTester],
    dragHandlers: [moveHandler, bendHandler, marqueeHandler] as DragHandler<LaneHit, unknown>[],
    keyBindings: [keys],
    dpr: options.dpr,
  });

  // Repaint on document change (the lane's points may have moved).
  const unsubStore: Unsub = store.onChange(() => {
    host.renderer.invalidate("content");
    host.renderer.invalidate("overlay");
  });

  return {
    element: host.element,
    setLane(nextLaneId: LaneId | null, nextDesc: ParamDescriptor | null): void {
      laneId = nextLaneId;
      desc = nextDesc;
      selection = new Set();
      host.renderer.invalidateAll();
    },
    setPlayheadTicks(tick: Ticks): void {
      host.playhead.setTicks(tick);
    },
    focus(): void {
      host.focus();
    },
    dispose(): void {
      unsubStore();
      host.dispose();
    },
  };
}
