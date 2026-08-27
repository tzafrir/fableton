// SS11 — automation-lane commands (SS18-M3).
//
// Points carry no ids: within a lane they are identified by their CURRENT
// tick `t` (document invariant: sorted by `t`, no two points on one tick).
// Every command that moves points therefore takes tick KEYS captured at
// gesture start plus target positions, and one drag = one command (SS13).
//
// `rebindLane` is the SS7 promise made concrete: a lane that outlived its
// param ("kept, greyed, and re-bindable — never silently deleted") is
// pointed at any other `ParamId` in two clicks.

import type {
  AutoPoint,
  Command,
  IdFactory,
  LaneId,
  ParamId,
  ProjectCommands,
  Ticks,
} from "../../types";
import { makeCommand, tick, type DraftProject } from "./util";

export type LaneCommands = Pick<
  ProjectCommands,
  | "addLane"
  | "deleteLanes"
  | "setLaneEnabled"
  | "rebindLane"
  | "addLanePoint"
  | "moveLanePoints"
  | "deleteLanePoints"
  | "setLaneSegmentCurve"
>;

function laneOf(doc: DraftProject, laneId: LaneId) {
  return doc.lanes[laneId];
}

/** Invariant: sorted by `t`, one point per tick (later write wins). */
function normalizePoints(points: AutoPoint[]): AutoPoint[] {
  points.sort((a, b) => a.t - b.t);
  const out: AutoPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last !== undefined && last.t === point.t) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

const clampCurve = (curve: number): number => Math.min(1, Math.max(-1, curve));

export function createLaneCommands(ids: IdFactory): LaneCommands {
  return {
    addLane(channelId, paramId: ParamId, init = {}): Command {
      const laneId = init.id ?? ids.lane();
      return makeCommand("Add Automation Lane", (doc) => {
        if (doc.channels[channelId] === undefined) return;
        // One lane per (channel, param): adding again just re-enables.
        const existing = Object.values(doc.lanes).find(
          (lane) => lane.channelId === channelId && lane.paramId === paramId,
        );
        if (existing !== undefined) {
          existing.enabled = true;
          return;
        }
        doc.lanes[laneId] = {
          id: laneId,
          channelId,
          paramId,
          points: init.points === undefined ? [] : normalizePoints([...init.points]),
          enabled: true,
        };
      });
    },

    deleteLanes(laneIds): Command {
      const targets = [...laneIds];
      return makeCommand(targets.length === 1 ? "Delete Lane" : "Delete Lanes", (doc) => {
        for (const id of targets) delete doc.lanes[id];
      });
    },

    setLaneEnabled(laneId, enabled): Command {
      return makeCommand(enabled ? "Enable Lane" : "Disable Lane", (doc) => {
        const lane = laneOf(doc, laneId);
        if (lane !== undefined) lane.enabled = enabled;
      });
    },

    rebindLane(laneId, paramId: ParamId): Command {
      return makeCommand("Re-bind Lane", (doc) => {
        const lane = laneOf(doc, laneId);
        if (lane !== undefined) lane.paramId = paramId;
      });
    },

    addLanePoint(laneId, point): Command {
      const copy: AutoPoint = { t: tick(point.t), v: point.v, curve: clampCurve(point.curve ?? 0) };
      return makeCommand("Add Automation Point", (doc) => {
        const lane = laneOf(doc, laneId);
        if (lane === undefined || copy.t < 0) return;
        lane.points = normalizePoints([...lane.points, copy]);
      });
    },

    moveLanePoints(laneId, edits): Command {
      // Captured eagerly: `fromT` keys the point as it was at gesture start.
      const moves = edits.map((e) => ({
        fromT: tick(e.fromT),
        toT: Math.max(0, tick(e.toT)),
        v: e.v,
      }));
      return makeCommand("Move Automation Points", (doc) => {
        const lane = laneOf(doc, laneId);
        if (lane === undefined) return;
        const byTick = new Map(moves.map((m) => [m.fromT, m]));
        const next: AutoPoint[] = lane.points.map((point) => {
          const move = byTick.get(point.t);
          if (move === undefined) return point;
          return { t: move.toT, v: move.v, curve: point.curve };
        });
        lane.points = normalizePoints(next);
      });
    },

    deleteLanePoints(laneId, ticks: readonly Ticks[]): Command {
      const dying = new Set(ticks.map(tick));
      return makeCommand("Delete Automation Points", (doc) => {
        const lane = laneOf(doc, laneId);
        if (lane === undefined) return;
        lane.points = lane.points.filter((point) => !dying.has(point.t));
      });
    },

    setLaneSegmentCurve(laneId, segmentStartT, curve): Command {
      const at = tick(segmentStartT);
      const bend = clampCurve(curve);
      return makeCommand("Bend Automation Segment", (doc) => {
        const lane = laneOf(doc, laneId);
        if (lane === undefined) return;
        const point = lane.points.find((p) => p.t === at);
        if (point !== undefined) point.curve = bend;
      });
    },
  };
}
