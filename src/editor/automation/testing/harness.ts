// SS15: "gesture FSMs are unit-tested by feeding synthetic pointer-event
// sequences ... no browser needed for any of the load-bearing logic."
//
// The automation lane editor WITHOUT the DOM: a real store, real lane
// commands, the real kit viewport/grid/gesture engine, and the editor's real
// hit tester, drag handlers and key binding — driven by plain objects. The
// piano roll's `testing/harness.ts` is the template; this is the same idea
// over `AutomationLaneContext`.

import type { Command } from "../../../types/commands";
import type { LaneId, ParamId } from "../../../types/ids";
import type { Modifiers, PointerInput } from "../../../types/gesture";
import type { ParamDescriptor } from "../../../types/params";
import type { Ticks } from "../../../types/time";
import type { Grid, GridSettings, Viewport } from "../../../types/viewport";
import type { AutoPoint } from "../../../types/document";
import { p } from "../../../params/descriptors";
import { withParamId } from "../../../params";
import { makeFixture } from "../../../state/testing/fixture";
import type { AppDocumentStore } from "../../../state/store";
import { createGrid } from "../../kit/grid";
import { createKitGestureEngine, type KitGestureEngine } from "../../kit/gestureEngine";
import { createViewport } from "../../kit/viewport";
import { editorPointOf, modifiers } from "../../kit/points";
import {
  createTickSelection,
  type AutomationLaneContext,
  type TickSelection,
} from "../context";
import { createAutomationDragHandlers } from "../handlers";
import { createAutomationHitTester, type LaneHit } from "../hits";
import { createAutomationKeyBinding } from "../keymap";
import { yOfValue } from "../layout";

/** `[t, v, curve?]` triples -> `AutoPoint`s. */
export const pts = (list: readonly [number, number, number?][]): AutoPoint[] =>
  list.map(([t, v, curve]) => ({ t, v, curve: curve ?? 0 }));

export const LANE_PARAM_ID: ParamId = "chan:chan-1/dev:dev-1/x";
export const LANE_ID: LaneId = "lane-1";

/** The default value axis: 0..100 linear, so a test can do its own arithmetic. */
export const CONTINUOUS_DESC: ParamDescriptor = withParamId(
  p.continuous("x", "X", { min: 0, max: 100, default: 0, unit: "u" }),
  LANE_PARAM_ID,
);

/** A 4-way choice — SS11's "stepped/enum/toggle ... as steps" case. */
export const ENUM_DESC: ParamDescriptor = withParamId(
  p.enum("type", "Type", { labels: ["lowpass", "highpass", "bandpass", "notch"], default: 0 }),
  LANE_PARAM_ID,
);

export interface AutomationHarnessOptions {
  points?: readonly [number, number, number?][] | undefined;
  desc?: ParamDescriptor | null | undefined;
  grid?: Partial<GridSettings> | undefined;
  widthPx?: number | undefined;
  heightPx?: number | undefined;
  pxPerTick?: number | undefined;
}

export interface AutomationHarness {
  readonly store: AppDocumentStore;
  readonly ctx: AutomationLaneContext;
  readonly engine: KitGestureEngine<LaneHit>;
  readonly viewport: Viewport;
  readonly grid: Grid;
  readonly selection: TickSelection;
  readonly laneId: LaneId;
  readonly heightPx: number;
  /** Commands the engine dispatched, in order. */
  readonly dispatched: Command[];

  // coordinates
  x(tick: Ticks): number;
  y(value: number): number;
  hit(x: number, y: number): LaneHit | null;

  // synthetic input
  down(x: number, y: number, mods?: Partial<Modifiers>, clickCount?: number): void;
  move(x: number, y: number, mods?: Partial<Modifiers>): void;
  up(x: number, y: number, mods?: Partial<Modifiers>, clickCount?: number): void;
  esc(): void;
  key(key: string, mods?: Partial<Modifiers>): boolean;
  drag(
    from: readonly [number, number],
    to: readonly [number, number],
    mods?: Partial<Modifiers>,
  ): void;
  click(x: number, y: number, mods?: Partial<Modifiers>, clickCount?: number): void;

  // reads
  points(): readonly AutoPoint[];
  ticks(): readonly Ticks[];
  values(): readonly number[];
  selected(): readonly Ticks[];
  labels(): string[];
}

const DEFAULT_POINTS: readonly [number, number, number?][] = [
  [0, 0],
  [960, 100],
  [1920, 50],
];

export function createAutomationHarness(
  options: AutomationHarnessOptions = {},
): AutomationHarness {
  const fixture = makeFixture();
  const { store, commands } = fixture;
  store.dispatch(
    commands.addLane(fixture.trackId, LANE_PARAM_ID, {
      id: LANE_ID,
      points: pts(options.points ?? DEFAULT_POINTS),
    }),
  );
  store.clearHistory();

  const heightPx = options.heightPx ?? 200;
  const viewport = createViewport({
    pxPerTick: options.pxPerTick ?? 0.05,
    pxPerRow: 16,
    widthPx: options.widthPx ?? 800,
    heightPx,
  });
  const grid = createGrid({ viewport, settings: options.grid });

  const desc = options.desc === undefined ? CONTINUOUS_DESC : options.desc;
  const selection = createTickSelection(() => undefined);

  const ctx: AutomationLaneContext = {
    commands,
    selection,
    viewport,
    grid,
    laneId: () => LANE_ID,
    desc: () => desc,
    points: () => (store.getState().lanes[LANE_ID]?.points ?? []) as readonly AutoPoint[],
    heightPx: () => heightPx,
  };

  const dispatched: Command[] = [];
  const hitTester = createAutomationHitTester(ctx);
  const engine = createKitGestureEngine<LaneHit>({
    viewport,
    grid,
    dispatch: (command) => {
      dispatched.push(command);
      store.dispatch(command);
    },
    hitTesters: [hitTester],
    dragHandlers: createAutomationDragHandlers(ctx),
    keyBindings: [createAutomationKeyBinding(ctx)],
  });

  const mods = (partial: Partial<Modifiers> = {}): Modifiers => modifiers(partial);
  const pointer = (
    x: number,
    y: number,
    partial: Partial<Modifiers> | undefined,
    clickCount: number,
    buttons: number,
  ): PointerInput => ({
    pointerId: 1,
    point: editorPointOf(viewport, x, y),
    button: 0,
    buttons,
    modifiers: mods(partial),
    clickCount,
  });

  const harness: AutomationHarness = {
    store,
    ctx,
    engine,
    viewport,
    grid,
    selection,
    laneId: LANE_ID,
    heightPx,
    dispatched,

    x: (tick) => viewport.xOf(tick),
    y: (value) => yOfValue(desc ?? CONTINUOUS_DESC, value, heightPx),
    hit: (x, y) => hitTester.hitTest(editorPointOf(viewport, x, y), mods()),

    down(x, y, m, clickCount = 1) {
      engine.pointerDown(pointer(x, y, m, clickCount, 1));
    },
    move(x, y, m) {
      engine.pointerMove(pointer(x, y, m, 1, 1));
    },
    up(x, y, m, clickCount = 1) {
      engine.pointerUp(pointer(x, y, m, clickCount, 0));
    },
    esc() {
      engine.keyDown({ key: "Escape", modifiers: mods() });
    },
    key(key, m) {
      return engine.keyDown({ key, modifiers: mods(m) });
    },
    drag(from, to, m) {
      this.down(from[0], from[1], m);
      this.move(to[0], to[1], m);
      this.up(to[0], to[1], m);
    },
    click(x, y, m, clickCount = 1) {
      this.down(x, y, m, clickCount);
      this.up(x, y, m, clickCount);
    },

    points: () => ctx.points(),
    ticks: () => ctx.points().map((point) => point.t),
    values: () => ctx.points().map((point) => point.v),
    selected: () => [...selection.ticks()].sort((a, b) => a - b),
    labels: () => dispatched.map((command) => command.label),
  };
  return harness;
}
