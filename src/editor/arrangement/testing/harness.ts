// SS15: "gesture FSMs are unit-tested by feeding synthetic pointer-event
// sequences ... no browser needed for any of the load-bearing logic."
//
// This harness builds the REAL thing headlessly: a real document store, the
// real `ProjectCommands`, the real scene/hit-testers/drag handlers, and the
// kit's real gesture engine — with plain objects standing in for pointer
// events. Nothing is stubbed except the pointer itself.

import type { Command, DocumentChange, Project, ProjectCommands } from "../../../types";
import type { ClipId } from "../../../types/ids";
import type { Modifiers, PointerInput } from "../../../types/gesture";
import type { SelectionModel } from "../../../types/editor";
import { createDocumentStore, createProjectCommands, createSequentialIdFactory, type AppDocumentStore } from "../../../state";
import { createGrid, createKitGestureEngine, createSelectionModel, createViewport, editorPointOf, modifiers, type KitGestureEngine } from "../../kit";
import type { Grid, Viewport } from "../../../types/viewport";
import { DEFAULT_THEME } from "../constants";
import type { ArrangementContext } from "../context";
import { createCreateDragHandler } from "../dragCreate";
import { createLoopDragHandler } from "../dragLoop";
import { createMarqueeDragHandler } from "../dragMarquee";
import { createMoveDragHandler } from "../dragMove";
import { createTrimDragHandler } from "../dragTrim";
import type { ArrangementHit } from "../hits";
import { createHitTesters } from "../hits";
import { createArrangementKeyBindings } from "../keys";
import type { ArrangementScene } from "../scene";
import { createArrangementScene } from "../scene";
import { createdClipIds } from "../arrangement";

export const TRACK_A = "chan-a";
export const TRACK_B = "chan-b";
export const MASTER = "chan-m";
export const CLIP_1 = "clip-1";
export const CLIP_2 = "clip-2";
export const CLIP_3 = "clip-3";

/** One bar of 4/4 at 960 PPQ. */
export const BAR = 3840;

/**
 * Three lanes: two tracks and the master, in `channelOrder` (invariant 2).
 * Clip 1 sits at bar 1 of track A, clip 2 at bar 3 of track A, clip 3 at
 * bar 2 of track B and is half a bar long.
 */
export function makeProject(): Project {
  const channel = (id: string, role: "track" | "master", name: string) => ({
    id,
    role,
    name,
    color: null,
    source: null,
    chain: [],
    volume: `chan:${id}/vol`,
    pan: `chan:${id}/pan`,
    mute: false,
    solo: false,
    sends: [],
    output: role === "master" ? null : MASTER,
  });
  return {
    id: "project-test",
    name: "Fixture",
    tempo: [{ startTick: 0, bpm: 120 }],
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { start: 0, end: BAR, enabled: false },
    channelOrder: [TRACK_A, TRACK_B, MASTER],
    channels: {
      [TRACK_A]: channel(TRACK_A, "track", "Track A"),
      [TRACK_B]: channel(TRACK_B, "track", "Track B"),
      [MASTER]: channel(MASTER, "master", "Master"),
    },
    devices: {},
    clips: {
      [CLIP_1]: {
        id: CLIP_1,
        trackId: TRACK_A,
        start: 0,
        length: BAR,
        notes: [
          { id: "note-1", start: 0, dur: 480, pitch: 60, vel: 100 },
          { id: "note-2", start: 1920, dur: 480, pitch: 64, vel: 100 },
        ],
      },
      [CLIP_2]: { id: CLIP_2, trackId: TRACK_A, start: BAR * 2, length: BAR, notes: [] },
      [CLIP_3]: { id: CLIP_3, trackId: TRACK_B, start: BAR, length: BAR / 2, notes: [] },
    },
    lanes: {},
    racks: {},
    sidechains: [],
    assets: {},
    paramValues: {},
  };
}

export interface Harness {
  readonly store: AppDocumentStore;
  readonly commands: ProjectCommands;
  readonly scene: ArrangementScene;
  readonly selection: SelectionModel<ClipId>;
  readonly viewport: Viewport;
  readonly grid: Grid;
  readonly engine: KitGestureEngine<ArrangementHit>;
  readonly context: ArrangementContext;
  /** Commands the engine dispatched, in order. */
  readonly dispatched: Command[];
  /** Clip ids handed to `onOpenClip` (SS18-M1's double-click). */
  readonly opened: ClipId[];
  readonly overlayInvalidations: () => number;
  playhead: number;
  /** Pixel helpers so tests read in screen coordinates. */
  down(x: number, y: number, mods?: Partial<Modifiers>, clickCount?: number): void;
  move(x: number, y: number, mods?: Partial<Modifiers>): void;
  up(x: number, y: number, mods?: Partial<Modifiers>, clickCount?: number): void;
  drag(from: readonly [number, number], to: readonly [number, number], mods?: Partial<Modifiers>): void;
  clip(id: ClipId): Project["clips"][string] | undefined;
  xOfTick(tick: number): number;
  yOfRow(row: number): number;
}

export interface HarnessOptions {
  project?: Project | undefined;
  /** Fixed grid division; 4 = one beat (960 ticks). Default 4. */
  gridDenominator?: number | undefined;
  pxPerTick?: number | undefined;
  pxPerRow?: number | undefined;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const store = createDocumentStore(options.project ?? makeProject());
  const commands = createProjectCommands(createSequentialIdFactory("t"));
  const scene = createArrangementScene(store.getState());
  const selection = createSelectionModel<ClipId>();
  const pxPerTick = options.pxPerTick ?? 0.05;
  const pxPerRow = options.pxPerRow ?? 40;
  const viewport = createViewport({ pxPerTick, pxPerRow, widthPx: 1200, heightPx: 200 });
  const grid = createGrid({
    viewport,
    settings: { mode: "fixed", denominator: options.gridDenominator ?? 4 },
  });

  const dispatched: Command[] = [];
  const opened: ClipId[] = [];
  let overlayCount = 0;
  let pendingSelectCreated = false;
  const harness: Harness = {
    store,
    commands,
    scene,
    selection,
    viewport,
    grid,
    dispatched,
    opened,
    overlayInvalidations: () => overlayCount,
    playhead: 0,
  } as Harness;

  const context: ArrangementContext = {
    store,
    commands,
    selection,
    scene,
    playheadTicks: () => harness.playhead,
    openClip: (clipId) => opened.push(clipId),
    selectChannel: () => undefined,
    selectCreatedClips: () => {
      pendingSelectCreated = true;
    },
  };

  // Same two subscriptions the mounted view makes (see ../arrangement.ts).
  store.onChange((change: DocumentChange) => {
    scene.update(change.doc, change.patches);
    if (pendingSelectCreated) {
      pendingSelectCreated = false;
      const created = createdClipIds(change.patches);
      if (created.length > 0) selection.set(created);
    }
  });

  const engine = createKitGestureEngine<ArrangementHit>({
    viewport,
    grid,
    dispatch: (command: Command) => {
      dispatched.push(command);
      store.dispatch(command);
    },
    invalidateOverlay: () => {
      overlayCount += 1;
    },
    hitTesters: createHitTesters(scene, viewport),
    dragHandlers: [
      createLoopDragHandler(context, DEFAULT_THEME),
      createTrimDragHandler(context, DEFAULT_THEME),
      createMoveDragHandler(context, DEFAULT_THEME),
      createCreateDragHandler(context, DEFAULT_THEME),
      createMarqueeDragHandler(context, DEFAULT_THEME),
    ],
    keyBindings: [createArrangementKeyBindings(context, grid)],
  });

  const input = (
    x: number,
    y: number,
    mods: Partial<Modifiers> | undefined,
    buttons: number,
    clickCount: number,
  ): PointerInput => ({
    pointerId: 1,
    point: editorPointOf(viewport, x, y),
    button: 0,
    buttons,
    modifiers: modifiers(mods ?? {}),
    clickCount,
  });

  return Object.assign(harness, {
    engine,
    context,
    down(x: number, y: number, mods?: Partial<Modifiers>, clickCount = 1): void {
      engine.pointerDown(input(x, y, mods, 1, clickCount));
    },
    move(x: number, y: number, mods?: Partial<Modifiers>): void {
      engine.pointerMove(input(x, y, mods, 1, 1));
    },
    up(x: number, y: number, mods?: Partial<Modifiers>, clickCount = 1): void {
      engine.pointerUp(input(x, y, mods, 0, clickCount));
    },
    drag(from: readonly [number, number], to: readonly [number, number], mods?: Partial<Modifiers>): void {
      engine.pointerDown(input(from[0], from[1], mods, 1, 1));
      engine.pointerMove(input(to[0], to[1], mods, 1, 1));
      engine.pointerUp(input(to[0], to[1], mods, 0, 1));
    },
    clip(id: ClipId) {
      return store.getState().clips[id] as Project["clips"][string] | undefined;
    },
    xOfTick(tick: number): number {
      return viewport.xOf(tick);
    },
    yOfRow(row: number): number {
      return viewport.yOf(row) + viewport.pxPerRow / 2;
    },
  });
}
