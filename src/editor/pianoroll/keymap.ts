// SS10's keyboard map, verbatim:
//
//   | up / down            | transpose +/-1 semitone (auditions at new pitch) |
//   | Shift+up/down        | transpose +/-1 octave                            |
//   | left / right         | move by current grid                             |
//   | Shift+left/right     | fine nudge (1/64 note)                           |
//   | Alt+left/right       | shorten / lengthen by grid                       |
//   | Cmd/Ctrl+D           | duplicate selection immediately after itself     |
//   | Cmd/Ctrl+A           | select all in clip                               |
//   | Delete               | delete selection                                 |
//   | 0                    | mute/unmute selected notes                       |
//   | Cmd/Ctrl+U           | quantize starts to grid                          |
//   | Esc                  | cancel drag -> clear selection                   |
//
// "Every action goes through the same commands the mouse uses — the keyboard
// is a first-class client of the editor, not a bolt-on." So every row below
// returns one `ProjectCommands` command, the same ones the drag handlers
// commit, and the engine dispatches it exactly like a drag's `commit`.
//
// `Esc` reaches this binding only when NO drag is live: the gesture engine
// consumes `Escape` while dragging (that is the FSM's "revert" column).

import type { Command } from "../../types/commands";
import type { KeyBinding, KeyInput, KeyOutcome } from "../../types/gesture";
import type { NoteId } from "../../types/ids";
import type { NoteSpan } from "../../types/commands";
import type { Ticks } from "../../types/time";
import { FINE_NUDGE_TICKS, MIN_NOTE_TICKS } from "../../types/editor";
import type { ContextRef, PianoRollContext } from "./context";
import type { KeyboardAudition } from "./audition";
import { clampGroupDelta } from "./dragCommon";
import type { RONote } from "./layout";

/** Consumed, but not a document edit: selection-only rows (`Cmd+A`, `Esc`). */
const HANDLED: KeyOutcome = { command: null, preventDefault: true };

function outcome(command: Command | null): KeyOutcome {
  return { command, preventDefault: true };
}

function selectedIds(notes: readonly RONote[]): NoteId[] {
  return notes.map((note) => note.id);
}

/** SS10 `Cmd/Ctrl+D`: "immediately after itself" = the selection's own span. */
export function duplicateDelta(notes: readonly RONote[], gridTicks: Ticks): Ticks {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note.start < min) min = note.start;
    if (note.start + note.dur > max) max = note.start + note.dur;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  // A zero-length span (one zero-duration note) would duplicate in place.
  return Math.max(max - min, Math.max(1, gridTicks));
}

function transpose(
  ctx: PianoRollContext,
  audition: KeyboardAudition,
  semitones: number,
): Command | null {
  const notes = ctx.selectedNotes();
  const clipId = ctx.clipId;
  if (clipId === null || notes.length === 0) return null;
  const delta = clampGroupDelta(notes, 0, semitones);
  if (delta.pitch === 0) return null;
  // "Auditions at new pitch" — before the command, from the ghost pitches.
  audition.strike(notes.map((note) => ({ pitch: note.pitch + delta.pitch, vel: note.vel })));
  return ctx.commands.moveNotes(clipId, selectedIds(notes), { ticks: 0, pitch: delta.pitch });
}

function nudge(ctx: PianoRollContext, deltaTicks: Ticks): Command | null {
  const notes = ctx.selectedNotes();
  const clipId = ctx.clipId;
  if (clipId === null || notes.length === 0) return null;
  const delta = clampGroupDelta(notes, deltaTicks, 0);
  if (delta.ticks === 0) return null;
  return ctx.commands.moveNotes(clipId, selectedIds(notes), { ticks: delta.ticks, pitch: 0 });
}

/** `Alt`+left/right: "shorten / lengthen by grid", floored at 1/128. */
function stretch(ctx: PianoRollContext, deltaTicks: Ticks): Command | null {
  const notes = ctx.selectedNotes();
  const clipId = ctx.clipId;
  if (clipId === null || notes.length === 0) return null;
  const spans: NoteSpan[] = [];
  for (const note of notes) {
    const dur = Math.max(MIN_NOTE_TICKS, note.dur + deltaTicks);
    if (dur !== note.dur) spans.push({ id: note.id, start: note.start, dur });
  }
  if (spans.length === 0) return null;
  return ctx.commands.resizeNotes(clipId, spans);
}

export interface PianoRollKeymapOptions {
  audition: KeyboardAudition;
  /** Called for `Esc` in `idle` so the view can also drop hover state. */
  onEscape?: (() => void) | undefined;
}

export function createPianoRollKeyBinding(
  ref: ContextRef,
  options: PianoRollKeymapOptions,
): KeyBinding {
  const { audition } = options;

  return {
    id: "pianoroll.keymap",
    priority: 0,

    handle(input: KeyInput): KeyOutcome | null {
      const ctx = ref();
      const clipId = ctx.clipId;
      const mods = input.modifiers;
      const grid = (): Ticks => Math.max(1, ctx.grid.gridTicks());

      switch (input.key) {
        case "ArrowUp":
        case "ArrowDown": {
          if (mods.primary) return null;
          const direction = input.key === "ArrowUp" ? 1 : -1;
          const semitones = direction * (mods.shift ? 12 : 1);
          const command = transpose(ctx, audition, semitones);
          return command === null && ctx.selection.size === 0 ? null : outcome(command);
        }

        case "ArrowLeft":
        case "ArrowRight": {
          if (mods.primary) return null;
          const direction = input.key === "ArrowRight" ? 1 : -1;
          if (mods.alt) {
            // Alt+right lengthens, Alt+left shortens (by the current grid).
            const command = stretch(ctx, direction * grid());
            return command === null && ctx.selection.size === 0 ? null : outcome(command);
          }
          const step = mods.shift ? FINE_NUDGE_TICKS : grid();
          const command = nudge(ctx, direction * step);
          return command === null && ctx.selection.size === 0 ? null : outcome(command);
        }

        case "Delete":
        case "Backspace": {
          if (clipId === null || ctx.selection.size === 0) return null;
          const ids = selectedIds(ctx.selectedNotes());
          if (ids.length === 0) return null;
          const command = ctx.commands.deleteNotes(clipId, ids);
          ctx.selection.clear();
          audition.stopAll();
          return outcome(command);
        }

        case "Escape": {
          // The engine already consumed `Esc` if a drag was live; reaching
          // here means `Idle`, whose column is "clear selection".
          audition.stopAll();
          options.onEscape?.();
          if (ctx.selection.size === 0) return HANDLED;
          ctx.selection.clear();
          return HANDLED;
        }

        default:
          break;
      }

      // Layout-stable digit: `code` survives non-US keyboards.
      if (input.key === "0" || input.code === "Digit0") {
        if (mods.primary || clipId === null) return null;
        const notes = ctx.selectedNotes();
        if (notes.length === 0) return null;
        // Toggle as a group: any unmuted note in the selection means "mute".
        const allMuted = notes.every((note) => note.muted === true);
        return outcome(
          ctx.commands.setNotesMuted(clipId, selectedIds(notes), !allMuted),
        );
      }

      if (!mods.primary) return null;
      const letter = input.key.toLowerCase();

      if (letter === "a") {
        if (clipId === null) return null;
        ctx.selection.set(ctx.notes().map((note) => note.id));
        return HANDLED;
      }

      if (letter === "d") {
        if (clipId === null) return null;
        const notes = ctx.selectedNotes();
        if (notes.length === 0) return null;
        const delta = duplicateDelta(notes, grid());
        return outcome(
          ctx.commands.duplicateNotes(clipId, selectedIds(notes), { ticks: delta, pitch: 0 }),
        );
      }

      if (letter === "u") {
        if (clipId === null) return null;
        const notes = ctx.selectedNotes();
        if (notes.length === 0) return null;
        return outcome(ctx.commands.quantizeNoteStarts(clipId, selectedIds(notes), grid()));
      }

      return null;
    },
  };
}
