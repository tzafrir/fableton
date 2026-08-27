// SS15: "gesture FSMs are unit-tested by feeding synthetic pointer-event
// sequences ... no browser needed for any of the load-bearing logic."
//
// This harness is the piano roll WITHOUT the DOM: a real store, real commands,
// the real kit viewport/grid/gesture engine, the real hit-testers, drag
// handlers and key bindings — driven by plain objects. Every FSM assertion in
// this package goes through it, so a test can never accidentally assert
// against a mock of the thing under test.

import type { Command } from "../../../types/commands";
import type { ClipId, NoteId } from "../../../types/ids";
import type { AuditionSink, ToolMode } from "../../../types/editor";
import type { Modifiers, PointerInput } from "../../../types/gesture";
import type { NoteInit } from "../../../types/commands";
import type { Ticks } from "../../../types/time";
import type { Grid, GridSettings, Viewport } from "../../../types/viewport";
import { createDocumentStore, type AppDocumentStore } from "../../../state/store";
import { createProjectCommands } from "../../../state/commands";
import { createSequentialIdFactory } from "../../../state/ids";
import { createEmptyProject } from "../../../state/project";
import { createGrid } from "../../kit/grid";
import { createKitGestureEngine, type KitGestureEngine } from "../../kit/gestureEngine";
import { createSelectionModel } from "../../kit/selection";
import { createViewport } from "../../kit/viewport";
import { editorPointOf, modifiers } from "../../kit/points";
import { createKeyboardAudition, type KeyboardAudition } from "../audition";
import { createPianoRollContext, type PianoRollContext } from "../context";
import { createPianoRollDragHandlers } from "../handlers";
import { createPianoRollHitTester, type PianoRollHit } from "../hits";
import { createPianoRollKeyBinding } from "../keymap";
import {
  createPianoRollLayout,
  rowOfPitch,
  yOfPitch,
  yOfVelocity,
  type PianoRollLayout,
} from "../layout";

export interface AuditionEvent {
  readonly op: "on" | "off" | "all-off";
  readonly pitch?: number;
  readonly vel?: number;
}

export interface RecordingAudition extends AuditionSink {
  readonly events: AuditionEvent[];
  ons(): number[];
  offs(): number[];
  reset(): void;
}

export function createRecordingAudition(): RecordingAudition {
  const events: AuditionEvent[] = [];
  return {
    events,
    noteOn(pitch: number, vel: number): void {
      events.push({ op: "on", pitch, vel });
    },
    noteOff(pitch: number): void {
      events.push({ op: "off", pitch });
    },
    allNotesOff(): void {
      events.push({ op: "all-off" });
    },
    ons(): number[] {
      return events.filter((e) => e.op === "on").map((e) => e.pitch ?? -1);
    },
    offs(): number[] {
      return events.filter((e) => e.op === "off").map((e) => e.pitch ?? -1);
    },
    reset(): void {
      events.length = 0;
    },
  };
}

export interface HarnessOptions {
  notes?: readonly NoteInit[] | undefined;
  tool?: ToolMode | undefined;
  grid?: Partial<GridSettings> | undefined;
  widthPx?: number | undefined;
  heightPx?: number | undefined;
  pxPerTick?: number | undefined;
  pxPerRow?: number | undefined;
  /** Pitch pinned to the top of the note grid. */
  topPitch?: number | undefined;
  onSeek?: ((tick: Ticks) => void) | undefined;
}

export interface Harness {
  readonly store: AppDocumentStore;
  readonly ctx: PianoRollContext;
  readonly engine: KitGestureEngine<PianoRollHit>;
  readonly viewport: Viewport;
  readonly grid: Grid;
  readonly layout: PianoRollLayout;
  readonly audition: RecordingAudition;
  readonly keyAudition: KeyboardAudition;
  readonly clipId: ClipId;
  /** Commands the engine dispatched, in order. */
  readonly dispatched: Command[];

  // coordinates
  x(tick: Ticks): number;
  yOfPitch(pitch: number): number;
  /** Vertical middle of a pitch row — the safe "body" y. */
  yMid(pitch: number): number;
  velY(vel: number): number;
  rulerY(): number;

  // synthetic input
  down(x: number, y: number, mods?: Partial<Modifiers>, clickCount?: number): void;
  move(x: number, y: number, mods?: Partial<Modifiers>): void;
  up(x: number, y: number, mods?: Partial<Modifiers>, clickCount?: number): void;
  cancelPointer(): void;
  esc(): void;
  key(key: string, mods?: Partial<Modifiers>, code?: string): boolean;
  drag(
    from: readonly [number, number],
    to: readonly [number, number],
    mods?: Partial<Modifiers>,
  ): void;

  // reads
  notes(): readonly { id: NoteId; start: number; dur: number; pitch: number; vel: number; muted?: boolean | undefined }[];
  note(id: NoteId): { id: NoteId; start: number; dur: number; pitch: number; vel: number; muted?: boolean | undefined } | undefined;
  selectionIds(): readonly NoteId[];
  labels(): string[];
}

const DEFAULT_NOTES: readonly NoteInit[] = [
  { id: "n1", start: 0, dur: 480, pitch: 60, vel: 100 },
  { id: "n2", start: 960, dur: 480, pitch: 64, vel: 100 },
];

export function createHarness(options: HarnessOptions = {}): Harness {
  const ids = createSequentialIdFactory();
  const commands = createProjectCommands(ids);
  const project = createEmptyProject({ ids, name: "Piano Roll Test" });
  const clipId = Object.keys(project.clips)[0] ?? "";
  const store = createDocumentStore(project, { now: () => 0 });
  store.dispatch(commands.addNotes(clipId, options.notes ?? DEFAULT_NOTES));
  store.clearHistory();

  const viewport = createViewport({
    pxPerTick: options.pxPerTick ?? 0.05,
    pxPerRow: options.pxPerRow ?? 16,
    widthPx: options.widthPx ?? 800,
    heightPx: options.heightPx ?? 400,
    limits: { minRow: 0, maxRow: 128 },
  });
  viewport.setScroll(0, rowOfPitch(options.topPitch ?? 72));

  const grid = createGrid({ viewport, settings: options.grid });
  const layout = createPianoRollLayout(viewport);
  const selection = createSelectionModel<NoteId>();
  const audition = createRecordingAudition();

  const dispatched: Command[] = [];

  const ctx = createPianoRollContext({
    store,
    commands,
    selection,
    viewport,
    grid,
    layout,
    clipId,
    tool: options.tool ?? "select",
    audition,
    onSeek: options.onSeek,
  });

  const keyAudition = createKeyboardAudition(() => ctx.audition, {
    // Deterministic: the hold timer never fires unless a test runs it.
    setTimer: () => 0,
    clearTimer: () => undefined,
  });

  const engine = createKitGestureEngine<PianoRollHit>({
    viewport,
    grid,
    dispatch: (command) => {
      dispatched.push(command);
      store.dispatch(command);
    },
    hitTesters: [createPianoRollHitTester(() => ctx)],
    dragHandlers: createPianoRollDragHandlers(() => ctx),
    keyBindings: [createPianoRollKeyBinding(() => ctx, { audition: keyAudition })],
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

  return {
    store,
    ctx,
    engine,
    viewport,
    grid,
    layout,
    audition,
    keyAudition,
    clipId,
    dispatched,

    x: (tick) => viewport.xOf(tick),
    yOfPitch: (pitch) => yOfPitch(viewport, layout, pitch),
    yMid: (pitch) => yOfPitch(viewport, layout, pitch) + viewport.pxPerRow / 2,
    velY: (vel) => yOfVelocity(layout, vel),
    rulerY: () => layout.rulerHeightPx / 2,

    down(x, y, m, clickCount = 1) {
      engine.pointerDown(pointer(x, y, m, clickCount, 1));
    },
    move(x, y, m) {
      engine.pointerMove(pointer(x, y, m, 1, 1));
    },
    up(x, y, m, clickCount = 1) {
      engine.pointerUp(pointer(x, y, m, clickCount, 0));
    },
    cancelPointer() {
      engine.pointerCancel(pointer(0, 0, undefined, 1, 0));
    },
    esc() {
      engine.keyDown({ key: "Escape", modifiers: mods() });
    },
    key(key, m, code) {
      return engine.keyDown({ key, code, modifiers: mods(m) });
    },
    drag(from, to, m) {
      this.down(from[0], from[1], m);
      this.move(to[0], to[1], m);
      this.up(to[0], to[1], m);
    },

    notes() {
      return store.getState().clips[clipId]?.notes ?? [];
    },
    note(id) {
      return this.notes().find((note) => note.id === id);
    },
    selectionIds() {
      return selection.ids();
    },
    labels() {
      return dispatched.map((command) => command.label);
    },
  };
}
