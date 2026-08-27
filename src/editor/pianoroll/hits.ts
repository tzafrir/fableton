// SS10 "Hit zones" — "Hover resolves to a zone before any button is pressed,
// and the cursor reflects it":
//
//   Body                 -> move
//   Left/right edge      -> `min(6 px, 40% of note width)` each side, so short
//                           notes always keep a grabbable body
//   Velocity lane stalk  -> drag sets velocity
//   Empty grid           -> marquee (or note creation in pencil mode)
//
// Pure functions over the context: the whole zone table is testable without a
// canvas, a DOM node or a pointer (SS15). Canvas + explicit hit-testing is the
// point of SS10's post-mortem — `elementFromPoint` cannot express edge zones.

import type { HitTarget, HitTester, Modifiers } from "../../types/gesture";
import type { EditorPoint } from "../../types/gesture";
import type { NoteId } from "../../types/ids";
import type { ContextRef, PianoRollContext } from "./context";
import {
  MAX_PITCH,
  MIN_PITCH,
  NOTE_HIT_SLOP_PX,
  VELOCITY_STALK_HIT_PX,
  edgeZonePx,
  isInRuler,
  isInVelocityLane,
  noteRect,
  pitchAtY,
  rowAtY,
  rowOfPitch,
  stalkX,
  yOfVelocity,
  type NoteRect,
  type RONote,
} from "./layout";

export type PianoRollZone =
  | "note-body"
  | "note-edge-l"
  | "note-edge-r"
  | "velocity-stalk"
  | "velocity-lane"
  | "grid"
  | "ruler";

export interface PianoRollHitBase extends HitTarget {
  readonly kind: PianoRollZone;
  readonly cursor: string;
}

export interface PianoRollNoteHit extends PianoRollHitBase {
  readonly kind: "note-body" | "note-edge-l" | "note-edge-r" | "velocity-stalk";
  readonly noteId: NoteId;
  readonly note: RONote;
}

export interface PianoRollEmptyHit extends PianoRollHitBase {
  readonly kind: "velocity-lane" | "grid" | "ruler";
}

export type PianoRollHit = PianoRollNoteHit | PianoRollEmptyHit;

export function isNoteHit(hit: PianoRollHit): hit is PianoRollNoteHit {
  return (
    hit.kind === "note-body" ||
    hit.kind === "note-edge-l" ||
    hit.kind === "note-edge-r" ||
    hit.kind === "velocity-stalk"
  );
}

/** Cursors, in one place so hover and drag agree (SS10). */
export const CURSORS = {
  body: "move",
  edge: "ew-resize",
  stalk: "ns-resize",
  lane: "crosshair",
  gridSelect: "default",
  gridPencil: "crosshair",
  ruler: "pointer",
} as const;

/** One reusable buffer for the range queries below: hover runs on every
 *  pointermove and must not allocate an array per event. Safe because no two
 *  of these calls are ever interleaved (they run to completion synchronously).
 */
const SCRATCH: RONote[] = [];
function scratch(): RONote[] {
  SCRATCH.length = 0;
  return SCRATCH;
}

export interface NoteHitResult {
  readonly note: RONote;
  readonly rect: NoteRect;
}

/**
 * The topmost note under a point in the note grid, or `null`.
 *
 * Notes are sorted by `(start, pitch)` (invariant 4), so the LAST match on a
 * row is the one drawn last — the one the user sees on an overlap.
 */
export function noteAtPoint(
  ctx: PianoRollContext,
  xPx: number,
  yPx: number,
): NoteHitResult | null {
  const { viewport, layout } = ctx;
  const row = rowAtY(viewport, layout, yPx);
  if (row < rowOfPitch(MAX_PITCH) || row >= rowOfPitch(MIN_PITCH) + 1) return null;
  const pitch = pitchAtY(viewport, layout, yPx);

  // SS9's culling rule applies to hover too: this runs on every pointermove,
  // so the candidates come from the binary-searched index, not a walk of the
  // clip. The window is the hit slop around the pointer; the index's own
  // left-edge search brings in notes that START further left and reach it.
  const slopTicks = Math.ceil((NOTE_HIT_SLOP_PX + 1) / Math.max(viewport.pxPerTick, 1e-9));
  const at = viewport.tAt(xPx);
  let best: NoteHitResult | null = null;
  for (const note of ctx.notesInRange(at - slopTicks, at + slopTicks + 1, scratch())) {
    if (note.pitch !== pitch) continue;
    const rect = noteRect(viewport, layout, note);
    // A note narrower than a pixel is still grabbable (SLOP), and a zero-width
    // rect must not swallow the whole row.
    const right = rect.x + Math.max(rect.w, 1);
    if (xPx < rect.x - NOTE_HIT_SLOP_PX || xPx > right + NOTE_HIT_SLOP_PX) continue;
    best = { note, rect };
  }
  return best;
}

/** The stalk under a point in the velocity lane, or `null`. */
export function stalkAtPoint(
  ctx: PianoRollContext,
  xPx: number,
  yPx: number,
): RONote | null {
  const { viewport, layout } = ctx;
  // A stalk stands at the note's START, so only notes starting within the hit
  // radius can match — again a range query rather than a full scan.
  const radiusTicks = Math.ceil((VELOCITY_STALK_HIT_PX + 1) / Math.max(viewport.pxPerTick, 1e-9));
  const at = viewport.tAt(xPx);
  let best: RONote | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const note of ctx.notesInRange(at - radiusTicks, at + radiusTicks + 1, scratch())) {
    const dx = Math.abs(stalkX(viewport, note) - xPx);
    if (dx > VELOCITY_STALK_HIT_PX) continue;
    // A chord stacks several stalks on one x; the nearest tip wins.
    const dy = Math.abs(yOfVelocity(layout, note.vel) - yPx);
    const score = dy + dx / 100;
    if (score < bestScore) {
      bestScore = score;
      best = note;
    }
  }
  return best;
}

/**
 * Zone of a note-relative x, per SS10's edge-zone rule.
 *
 * The rule is measured on the TARGET, not on the drawn rectangle: `noteAtPoint`
 * accepts `NOTE_HIT_SLOP_PX` of slop on each side, and splitting only the drawn
 * width would hand that slop entirely to the two resize zones — at low zoom a
 * 2.4 px note would end up ~7% body instead of the 20% `min(6 px, 40%)`
 * guarantees, i.e. effectively un-draggable. Widening by the same slop keeps
 * the promise ("short notes always keep a grabbable body") on the target the
 * user can actually hit.
 */
export function zoneOfNoteX(
  rect: NoteRect,
  xPx: number,
  slopPx: number = NOTE_HIT_SLOP_PX,
): PianoRollNoteHit["kind"] {
  const left = rect.x - slopPx;
  const width = Math.max(rect.w, 1) + slopPx * 2;
  const edge = edgeZonePx(width);
  if (xPx <= left + edge) return "note-edge-l";
  if (xPx >= left + width - edge) return "note-edge-r";
  return "note-body";
}

/** The whole zone table as one pure function. */
export function hitTestPianoRoll(
  ctx: PianoRollContext,
  point: EditorPoint,
): PianoRollHit | null {
  const { layout } = ctx;

  if (isInRuler(layout, point.yPx)) {
    return { kind: "ruler", cursor: CURSORS.ruler };
  }

  if (isInVelocityLane(layout, point.yPx)) {
    if (ctx.clipId === null) return { kind: "velocity-lane", cursor: CURSORS.lane };
    const note = stalkAtPoint(ctx, point.xPx, point.yPx);
    if (note !== null) {
      return { kind: "velocity-stalk", cursor: CURSORS.stalk, noteId: note.id, note };
    }
    return { kind: "velocity-lane", cursor: CURSORS.lane };
  }

  if (ctx.clipId === null) return null;

  const hit = noteAtPoint(ctx, point.xPx, point.yPx);
  if (hit !== null) {
    const kind = zoneOfNoteX(hit.rect, point.xPx);
    return {
      kind,
      cursor: kind === "note-body" ? CURSORS.body : CURSORS.edge,
      noteId: hit.note.id,
      note: hit.note,
    };
  }

  // Empty grid is a target in its own right: SS10's `Marquee` and the pencil's
  // `Paint` both start here, so the FSM must see a hit.
  return {
    kind: "grid",
    cursor: ctx.tool === "pencil" ? CURSORS.gridPencil : CURSORS.gridSelect,
  };
}

export function createPianoRollHitTester(ref: ContextRef): HitTester<PianoRollHit> {
  return {
    id: "pianoroll.zones",
    priority: 0,
    hitTest(point: EditorPoint, _modifiers: Modifiers): PianoRollHit | null {
      return hitTestPianoRoll(ref(), point);
    },
  };
}
