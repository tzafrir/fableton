// The arrangement's verb math, as pure functions.
//
// SS9: "Every drag operates on a PREVIEW (ghosts in the overlay) and commits
// exactly one command on release." Everything a drag needs to compute — the
// clamped delta, the ghost rectangles, and the exact command payload — is a
// pure function of (scene, targets, delta) and lives here, so the FSM tests
// can assert the geometry directly and the handlers stay ten lines each.
//
// Ghosts and the committed command are computed by the SAME function, which
// is what makes "what you dragged is what you get" structural rather than a
// thing to remember.

import type { ClipSpan } from "../../types/commands";
import type { ClipId } from "../../types/ids";
import type { Ticks } from "../../types/time";
import { MIN_CLIP_TICKS, loopAfterGrow } from "../../types/editor";
import type { ClipView } from "./geometry";
import { isAudioClip, loopOf } from "./geometry";
import type { ArrangementScene } from "./scene";

/** One previewed clip rectangle, in musical units. */
export interface ClipGhost {
  readonly clipId: ClipId;
  readonly row: number;
  readonly start: Ticks;
  readonly length: Ticks;
  /** Clip-relative loop window, or `null` when the clip has none. */
  readonly loop: { readonly start: Ticks; readonly end: Ticks } | null;
  readonly label: string;
}

export type TrimEdge = "start" | "end";

/** Folds `-0` (which `Math.max(x, -0)` happily produces) so a clamped delta
 *  never carries a negative-zero sign into an equality check or a patch. */
function noNegZero(value: number): number {
  return value === 0 ? 0 : value;
}

function labelOf(clip: ClipView, scene: ArrangementScene): string {
  if (clip.name !== undefined && clip.name !== "") return clip.name;
  return scene.doc.channels[clip.trackId]?.name ?? "";
}

function ghostLoopOf(clip: ClipView): ClipGhost["loop"] {
  const loop = loopOf(clip);
  return loop === null ? null : { start: loop.start, end: loop.end };
}

/**
 * SS10's selection rule for a drag: a drag that starts on a member of the
 * selection moves the WHOLE selection; one that starts elsewhere acts on the
 * clip under the pointer alone.
 */
export function dragTargets(
  scene: ArrangementScene,
  clipId: ClipId,
  selectedIds: readonly ClipId[],
): ClipView[] {
  const grabbed = scene.clip(clipId);
  if (grabbed === undefined) return [];
  if (!selectedIds.includes(clipId)) return [grabbed];
  const out: ClipView[] = [];
  for (const id of selectedIds) {
    const clip = scene.clip(id);
    if (clip !== undefined) out.push(clip);
  }
  return out.length === 0 ? [grabbed] : out;
}

/** Largest legal row delta no further from 0 than `desired`. */
export function clampRowDelta(desired: number, ok: (delta: number) => boolean): number {
  let delta = Math.trunc(desired);
  const step = delta > 0 ? -1 : 1;
  while (delta !== 0 && !ok(delta)) delta += step;
  return ok(delta) ? delta : 0;
}

/**
 * Clamps a whole-selection move: the group moves together or not at all.
 * Time cannot go before tick 0, and every clip must land on a `'track'` lane
 * (SS6: clips do not live on groups, returns or the master).
 */
export function clampMoveDelta(
  scene: ArrangementScene,
  clips: readonly ClipView[],
  deltaTicks: Ticks,
  deltaRows: number,
): { readonly ticks: Ticks; readonly rows: number } {
  if (clips.length === 0) return { ticks: 0, rows: 0 };
  let minStart = Number.POSITIVE_INFINITY;
  for (const clip of clips) if (clip.start < minStart) minStart = clip.start;
  const ticks = noNegZero(Math.max(Math.round(deltaTicks), -minStart));
  const rows = clips.map((clip) => scene.rowOfClip(clip.id));
  const legal = (candidate: number): boolean =>
    rows.every((row) => row < 0 || scene.isTrackRow(row + candidate));
  return { ticks, rows: clampRowDelta(deltaRows, legal) };
}

/** Ghosts for a move (or a duplicate — same geometry, different command). */
export function moveGhosts(
  scene: ArrangementScene,
  clips: readonly ClipView[],
  deltaTicks: Ticks,
  deltaRows: number,
): ClipGhost[] {
  return clips.map((clip) => {
    const row = scene.rowOfClip(clip.id);
    return {
      clipId: clip.id,
      row: row < 0 ? 0 : row + deltaRows,
      start: Math.max(0, clip.start + deltaTicks),
      length: clip.length,
      loop: ghostLoopOf(clip),
      label: labelOf(clip, scene),
    };
  });
}

/**
 * Clamps a trim so the whole selection keeps a legal span: `start >= 0` and
 * `length >= MIN_CLIP_TICKS` for every clip (SS10's resize floor, clip
 * flavour). The moving edge is the only one that changes (SS10: "Resize snaps
 * the moving edge, never the anchored one").
 */
export function clampTrimDelta(
  clips: readonly ClipView[],
  edge: TrimEdge,
  deltaTicks: Ticks,
): Ticks {
  if (clips.length === 0) return 0;
  let delta = Math.round(deltaTicks);
  if (edge === "end") {
    let lowest = Number.NEGATIVE_INFINITY;
    for (const clip of clips) lowest = Math.max(lowest, MIN_CLIP_TICKS - clip.length);
    return noNegZero(Math.max(delta, lowest));
  }
  let lowest = Number.NEGATIVE_INFINITY;
  let highest = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    lowest = Math.max(lowest, -clip.start);
    highest = Math.min(highest, clip.length - MIN_CLIP_TICKS);
  }
  delta = Math.max(delta, lowest);
  return noNegZero(Math.min(delta, highest));
}

export interface TrimResult {
  readonly ghosts: readonly ClipGhost[];
  readonly spans: readonly ClipSpan[];
  readonly delta: Ticks;
}

/**
 * Absolute spans for `ProjectCommands.trimClips` plus the matching ghosts.
 * The left edge also slides the clip's loop window, mirroring what
 * `trimClips` does to the document, so the ghost tells the truth.
 */
export function trimClips(
  scene: ArrangementScene,
  clips: readonly ClipView[],
  edge: TrimEdge,
  deltaTicks: Ticks,
): TrimResult {
  const delta = clampTrimDelta(clips, edge, deltaTicks);
  const ghosts: ClipGhost[] = [];
  const spans: ClipSpan[] = [];
  for (const clip of clips) {
    const start = edge === "start" ? clip.start + delta : clip.start;
    const length = edge === "start" ? clip.length - delta : clip.length + delta;
    spans.push({ id: clip.id, start, length });
    // The ghost predicts the loop the release will produce — including the
    // brace a right-edge GROW adds by itself (`loopAfterGrow`), so the
    // repeats appear under the pointer as the clip is stretched instead of
    // arriving as a surprise on mouse-up.
    const loop =
      ghostLoopOf(clip) ??
      (edge === "end"
        ? loopAfterGrow({
            previousLength: clip.length,
            newLength: length,
            hasLoop: false,
            // An audio clip has no notes to tile; `loopAfterGrow` declines
            // for it, which is the same answer it gives an empty MIDI clip.
            hasNotes: !isAudioClip(clip) && clip.notes.length > 0,
          })
        : null);
    const row = scene.rowOfClip(clip.id);
    ghosts.push({
      clipId: clip.id,
      row: row < 0 ? 0 : row,
      start,
      length,
      loop:
        loop === null
          ? null
          : edge === "start"
            ? { start: Math.max(0, loop.start - delta), end: Math.min(length, loop.end - delta) }
            : loop,
      label: labelOf(clip, scene),
    });
  }
  return { ghosts, spans, delta };
}

/** Clip-relative loop window after dragging one of its handles (or the whole
 *  brace). Clamped to `[0, clip.length]` with at least one tick of loop. */
export function loopAfterDrag(
  clip: ClipView,
  part: "loopStart" | "loopEnd" | "loopBody",
  deltaTicks: Ticks,
): { readonly start: Ticks; readonly end: Ticks } | null {
  const loop = loopOf(clip);
  if (loop === null) return null;
  const delta = Math.round(deltaTicks);
  if (part === "loopStart") {
    const start = Math.min(Math.max(0, loop.start + delta), loop.end - 1);
    return { start, end: loop.end };
  }
  if (part === "loopEnd") {
    const end = Math.max(Math.min(clip.length, loop.end + delta), loop.start + 1);
    return { start: loop.start, end };
  }
  const width = loop.end - loop.start;
  const start = Math.min(Math.max(0, loop.start + delta), Math.max(0, clip.length - width));
  return { start, end: start + width };
}

/** The default loop window a clip gets when looping is switched on: its whole
 *  content, which is what makes the brace immediately draggable. */
export function defaultLoopFor(clip: ClipView): { readonly start: Ticks; readonly end: Ticks } {
  return { start: 0, end: Math.max(1, clip.length) };
}

export interface CreateSpan {
  readonly start: Ticks;
  readonly length: Ticks;
}

/**
 * The span of a create-drag. SS10: "absolute snap applies only when
 * creating" — both edges snap, the start down and the end up, so a drag
 * anywhere inside a bar produces exactly that bar. `minLength` is the grid
 * division, floored at `MIN_CLIP_TICKS`.
 */
export function createSpan(
  anchorTick: Ticks,
  pointerTick: Ticks,
  snapFloor: (tick: Ticks) => Ticks,
  snapCeil: (tick: Ticks) => Ticks,
  minLength: Ticks,
): CreateSpan {
  const lo = Math.max(0, Math.min(anchorTick, pointerTick));
  const hi = Math.max(0, Math.max(anchorTick, pointerTick));
  const start = noNegZero(Math.max(0, snapFloor(lo)));
  const end = snapCeil(hi);
  const floor = Math.max(MIN_CLIP_TICKS, Math.round(minLength));
  return { start, length: Math.max(floor, end - start) };
}
