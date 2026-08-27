// SS11 — everything the lane editor's hit tester, drag handlers and key
// binding need, in one object. Same split as the piano roll's `context.ts`:
// the VIEW owns the canvas, the DOM and the mutable "which lane am I showing"
// state; the verbs below take a context and are therefore drivable headless
// (SS15), which is how `fsm.test.ts` exercises them without a browser.

import type {
  AutoPoint,
  Grid,
  LaneId,
  ParamDescriptor,
  ProjectCommands,
  Ticks,
  Viewport,
} from "../../types";
import type { SegmentMode } from "../../engine/automation/curve";

/**
 * SS13 ephemeral selection. Points carry no ids — inside a lane a point IS
 * its tick — so the kit's `SelectionModel<string>` does not fit and this
 * tick-keyed twin stands in. Every mutation notifies, so no call site can
 * forget to invalidate the overlay.
 */
export interface TickSelection {
  readonly size: number;
  has(tick: Ticks): boolean;
  ticks(): readonly Ticks[];
  set(ticks: Iterable<Ticks>): void;
  add(tick: Ticks): void;
  toggle(tick: Ticks): void;
  remove(tick: Ticks): void;
  clear(): void;
}

export function createTickSelection(onChange: () => void): TickSelection {
  let ticks = new Set<Ticks>();
  const replace = (next: Set<Ticks>): void => {
    if (next.size === ticks.size && [...next].every((t) => ticks.has(t))) return;
    ticks = next;
    onChange();
  };
  return {
    get size() {
      return ticks.size;
    },
    has: (tick) => ticks.has(tick),
    ticks: () => [...ticks],
    set(next) {
      replace(new Set(next));
    },
    add(tick) {
      replace(new Set([...ticks, tick]));
    },
    toggle(tick) {
      const next = new Set(ticks);
      if (!next.delete(tick)) next.add(tick);
      replace(next);
    },
    remove(tick) {
      const next = new Set(ticks);
      if (next.delete(tick)) replace(next);
    },
    clear() {
      replace(new Set());
    },
  };
}

export interface AutomationLaneContext {
  readonly commands: ProjectCommands;
  readonly viewport: Viewport;
  readonly grid: Grid;
  readonly selection: TickSelection;
  /** The lane being edited; `null` when the panel has none selected. */
  laneId(): LaneId | null;
  /** The target param's descriptor — it maps the value axis. `null` = greyed
   *  lane (SS7: a lane that outlived its param is kept, not deleted). */
  desc(): ParamDescriptor | null;
  /** The lane's points, sorted by tick (document invariant). */
  points(): readonly AutoPoint[];
  /** The lane's height in CSS pixels — the value axis's span. */
  heightPx(): number;
}

/**
 * SS11: "Stepped/enum/toggle params render and edit as steps." A discrete
 * lane is a staircase EVERYWHERE — drawn, hit-tested and played back through
 * curve.ts's `'hold'` mode — so the picture, the pointer and the audio agree.
 */
export function segmentModeOf(desc: ParamDescriptor): SegmentMode {
  return desc.kind === "continuous" ? "interpolate" : "hold";
}
