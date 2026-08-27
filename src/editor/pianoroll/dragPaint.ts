// SS10 FSM row `Paint`, plus the ruler scrub the shell asks for via `onSeek`.
//
//   | Paint | pencil drag | create note, extend while dragging right | one
//   | command per note | revert |
//
// One stroke is one note (and therefore one command, which is also the kit's
// hard rule: a gesture commits exactly one command). Creation is the ONLY
// place SS10 uses ABSOLUTE snapping: "absolute snap applies only when
// creating". `Alt` still bypasses it.

import type { Command } from "../../types/commands";
import type { DragHandler, DragUpdate, GestureStart } from "../../types/gesture";
import { DEFAULT_NOTE_VELOCITY, MIN_NOTE_TICKS } from "../../types/editor";
import { snapCreateTick } from "../kit/snapping";
import type { ContextRef } from "./context";
import type { PianoRollHit } from "./hits";
import { pitchAtY } from "./layout";
import { HANDLER_IDS, type PaintPreview, type SeekPreview } from "./preview";

export function createPaintDragHandler(ref: ContextRef): DragHandler<PianoRollHit, PaintPreview> {
  return {
    id: HANDLER_IDS.paint,
    // Above the marquee: in pencil mode the empty grid means "create".
    priority: 40,
    cursor: "crosshair",
    // The note appears on pointerdown, not after 3 px (that IS the pencil).
    thresholdPx: 0,

    claim(start: GestureStart<PianoRollHit>): boolean {
      const ctx = ref();
      return (
        start.button === 0 &&
        start.hit.kind === "grid" &&
        ctx.tool === "pencil" &&
        ctx.clipId !== null
      );
    },

    begin(start: GestureStart<PianoRollHit>): PaintPreview {
      const ctx = ref();
      const tick = Math.max(
        0,
        snapCreateTick(ctx.grid, start.point.tick, start.modifiers, "floor"),
      );
      const pitch = pitchAtY(ctx.viewport, ctx.layout, start.point.yPx);
      ctx.audition?.noteOn(pitch, DEFAULT_NOTE_VELOCITY);
      return {
        kind: "paint",
        ghost: {
          id: null,
          start: tick,
          dur: Math.max(MIN_NOTE_TICKS, ctx.grid.gridTicks()),
          pitch,
          vel: DEFAULT_NOTE_VELOCITY,
        },
      };
    },

    update(update: DragUpdate<PianoRollHit, PaintPreview>): PaintPreview {
      const ctx = ref();
      const ghost = update.preview.ghost;
      // "Extend while dragging right": the pitch is fixed by the pointerdown,
      // so one stroke is one note however much the pointer wanders vertically.
      const end = snapCreateTick(ctx.grid, update.point.tick, update.modifiers, "ceil");
      const grid = Math.max(MIN_NOTE_TICKS, ctx.grid.gridTicks());
      const dur = Math.max(grid, end - ghost.start);
      if (dur === ghost.dur) return update.preview;
      return { kind: "paint", ghost: { ...ghost, dur } };
    },

    commit(update: DragUpdate<PianoRollHit, PaintPreview>): Command | null {
      const ctx = ref();
      const ghost = update.preview.ghost;
      ctx.audition?.noteOff(ghost.pitch);
      const clipId = ctx.clipId;
      if (clipId === null) return null;
      return ctx.commands.addNotes(clipId, [
        { start: ghost.start, dur: ghost.dur, pitch: ghost.pitch, vel: ghost.vel },
      ]);
    },

    cancel(preview: PaintPreview): void {
      ref().audition?.noteOff(preview.ghost.pitch);
    },
  };
}

/**
 * Ruler scrub. Not an SS10 FSM row — it is the shell's `onSeek` (transport
 * seek), so it dispatches no command at all and snaps absolutely like every
 * other "placement" (SS10 lists playhead placement with creation).
 */
export function createSeekDragHandler(ref: ContextRef): DragHandler<PianoRollHit, SeekPreview> {
  const snapSeek = (tick: number, modifiers: GestureStart<PianoRollHit>["modifiers"]): number =>
    Math.max(0, snapCreateTick(ref().grid, tick, modifiers, "nearest"));

  return {
    id: HANDLER_IDS.seek,
    priority: 50,
    cursor: "pointer",
    thresholdPx: 0,

    claim(start: GestureStart<PianoRollHit>): boolean {
      return start.button === 0 && start.hit.kind === "ruler";
    },

    begin(start: GestureStart<PianoRollHit>): SeekPreview {
      const tick = snapSeek(start.point.tick, start.modifiers);
      ref().seek(tick);
      return { kind: "seek", tick };
    },

    update(update: DragUpdate<PianoRollHit, SeekPreview>): SeekPreview {
      // One seek per DISTINCT tick: the engine replays the promoting move and
      // the release point through `update`, and the transport should not be
      // told the same position three times.
      const tick = snapSeek(update.point.tick, update.modifiers);
      if (tick === update.preview.tick) return update.preview;
      ref().seek(tick);
      return { kind: "seek", tick };
    },

    commit(): Command | null {
      return null;
    },

    cancel(): void {
      // Nothing: seeking is transport state, not document state.
    },
  };
}
