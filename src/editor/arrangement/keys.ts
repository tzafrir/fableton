// SS10: "Every action goes through the same commands the mouse uses — the
// keyboard is a first-class client of the editor, not a bolt-on."
//
// The arrangement's map, the clip analogue of SS10's note map:
//
//   Delete / Backspace   delete the selection
//   left / right         move by the current grid   (Shift: fine nudge, 1/64)
//   up / down            move one lane
//   Alt + left/right     shorten / lengthen by the grid (right edge)
//   Cmd/Ctrl + D         duplicate the selection immediately after itself
//   Cmd/Ctrl + A         select every clip
//   Cmd/Ctrl + E         split the selection at the playhead
//   Cmd/Ctrl + L         toggle the clip loop brace on the selection
//   Escape               clear the selection
//
// A key action that spans several clips uses `store.batch` — "N commands, ONE
// undo entry" (types/commands) — so a nudge of six clips is still one undo.

import type { KeyBinding, KeyInput, KeyOutcome } from "../../types";
import type { ClipId } from "../../types/ids";
import type { Ticks } from "../../types/time";
import type { Grid } from "../../types/viewport";
import { FINE_NUDGE_TICKS, MIN_CLIP_TICKS } from "../../types/editor";
import type { ArrangementContext } from "./context";
import type { ClipView } from "./geometry";
import { defaultLoopFor } from "./edits";

const CONSUMED: KeyOutcome = { command: null, preventDefault: true };

export const KEY_BINDING_ID = "arrangement.keys";

/** Clips of the selection the playhead actually crosses. A LOOPED clip is
 *  excluded: `splitClip.canRun` rejects it ("unrolled content has no single
 *  split point"), and the arrangement disables the verb rather than
 *  dispatching a command it knows will be refused. */
export function splittableClips(context: ArrangementContext, at: Ticks): ClipView[] {
  const out: ClipView[] = [];
  for (const id of context.selection.ids()) {
    const clip = context.scene.clip(id);
    if (clip === undefined) continue;
    if (clip.loop !== undefined && clip.loop !== null) continue;
    if (at > clip.start && at < clip.start + clip.length) out.push(clip);
  }
  return out;
}

/** Splits every splittable selected clip at `at`. N clips, ONE undo entry
 *  (types/commands `batch`). Returns how many clips were split. */
export function splitSelectionAt(context: ArrangementContext, at: Ticks): number {
  const clips = splittableClips(context, at);
  if (clips.length === 0) return 0;
  const commands = clips.map((clip) => context.commands.splitClip(clip.id, at));
  if (commands.length === 1) {
    const only = commands[0];
    if (only === undefined) return 0;
    context.store.dispatch(only);
  } else {
    context.store.batch("Split Clips", commands);
  }
  return clips.length;
}

/** Toggles the loop brace over the selection: clears it when every selected
 *  clip is looped, otherwise loops the ones that are not. */
export function toggleLoopOnSelection(context: ArrangementContext): number {
  const clips: ClipView[] = [];
  for (const id of context.selection.ids()) {
    const clip = context.scene.clip(id);
    if (clip !== undefined) clips.push(clip);
  }
  if (clips.length === 0) return 0;
  const looped = (clip: ClipView): boolean => clip.loop !== undefined && clip.loop !== null;
  const allLooped = clips.every(looped);
  const targets = allLooped ? clips : clips.filter((clip) => !looped(clip));
  const commands = targets.map((clip) =>
    allLooped
      ? context.commands.setClipLoop(clip.id, null)
      : context.commands.setClipLoop(clip.id, defaultLoopFor(clip)),
  );
  if (commands.length === 0) return 0;
  if (commands.length === 1) {
    const only = commands[0];
    if (only === undefined) return 0;
    context.store.dispatch(only);
  } else {
    context.store.batch(allLooped ? "Clear Clip Loop" : "Set Clip Loop", commands);
  }
  return commands.length;
}

export function createArrangementKeyBindings(
  context: ArrangementContext,
  grid: Grid,
): KeyBinding {
  const selectedClips = (): ClipView[] => {
    const out: ClipView[] = [];
    for (const id of context.selection.ids()) {
      const clip = context.scene.clip(id);
      if (clip !== undefined) out.push(clip);
    }
    return out;
  };

  const nudge = (deltaTicks: Ticks, deltaRows: number): KeyOutcome | null => {
    const ids = selectedClips().map((clip) => clip.id);
    if (ids.length === 0) return null;
    return { command: context.commands.moveClips(ids, { ticks: deltaTicks, tracks: deltaRows }), preventDefault: true };
  };

  const resize = (deltaTicks: Ticks): KeyOutcome | null => {
    const clips = selectedClips();
    if (clips.length === 0) return null;
    return {
      command: context.commands.trimClips(
        clips.map((clip) => ({
          id: clip.id,
          start: clip.start,
          length: Math.max(MIN_CLIP_TICKS, clip.length + deltaTicks),
        })),
      ),
      preventDefault: true,
    };
  };

  return {
    id: KEY_BINDING_ID,
    priority: 0,
    handle(input: KeyInput): KeyOutcome | null {
      const { key, modifiers } = input;
      const gridTicks = grid.gridTicks();

      if (key === "Escape") {
        if (context.selection.size === 0) return null;
        context.selection.clear();
        return CONSUMED;
      }

      if (key === "Delete" || key === "Backspace") {
        const ids: readonly ClipId[] = context.selection.ids();
        if (ids.length === 0) return null;
        context.selection.clear();
        return { command: context.commands.deleteClips(ids), preventDefault: true };
      }

      if (modifiers.primary && (key === "a" || key === "A")) {
        context.selection.set(Object.keys(context.scene.doc.clips));
        return CONSUMED;
      }

      if (modifiers.primary && (key === "d" || key === "D")) {
        const clips = selectedClips();
        if (clips.length === 0) return null;
        // "Duplicate selection immediately after itself" (SS10): the offset is
        // the span of the selection, so a run of clips tiles seamlessly.
        let lo = Number.POSITIVE_INFINITY;
        let hi = 0;
        for (const clip of clips) {
          lo = Math.min(lo, clip.start);
          hi = Math.max(hi, clip.start + clip.length);
        }
        context.selectCreatedClips();
        return {
          command: context.commands.duplicateClips(
            clips.map((clip) => clip.id),
            { ticks: hi - lo, tracks: 0 },
          ),
          preventDefault: true,
        };
      }

      if (modifiers.primary && (key === "e" || key === "E")) {
        return splitSelectionAt(context, context.playheadTicks()) === 0 ? null : CONSUMED;
      }

      if (modifiers.primary && (key === "l" || key === "L")) {
        return toggleLoopOnSelection(context) === 0 ? null : CONSUMED;
      }

      if (key === "ArrowLeft" || key === "ArrowRight") {
        const sign = key === "ArrowLeft" ? -1 : 1;
        const step = modifiers.shift ? FINE_NUDGE_TICKS : gridTicks;
        // SS10: `Alt`+left/right shortens / lengthens instead of moving.
        if (modifiers.alt) return resize(sign * step);
        return nudge(sign * step, 0);
      }

      if (key === "ArrowUp" || key === "ArrowDown") {
        return nudge(0, key === "ArrowUp" ? -1 : 1);
      }

      return null;
    },
  };
}
