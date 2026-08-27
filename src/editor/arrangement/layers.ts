// SS9's layer stack for the arrangement skin:
//
//   grid    — lanes, bar/beat/grid lines. Redraws on viewport change only.
//   content — clips (+ their note miniatures and loop braces). Redraws on
//             document or viewport change; a moving ghost never touches it.
//   overlay — selection, hover and the active drag's ghosts (./ghosts.ts).
//
// Culling is not optional: `scene.clipsInRange` binary-searches each lane's
// `TickIndex`, and only the visible lanes are visited at all, so a frame costs
// O(visible) no matter how long the song is (SS9/SS2).

import type { EditorLayer, LayerFrame } from "../../types/render";
import type { SelectionModel } from "../../types/editor";
import type { ClipId } from "../../types/ids";
import type { Ticks } from "../../types/time";
import type { Grid } from "../../types/viewport";
import { ticksPerBar, ticksPerBeat } from "../../time";
import { alignHalfPixel, alignPixel } from "../kit";
import type { ArrangementTheme } from "./constants";
import type { ClipView } from "./geometry";
import { braceHeightPx, clipRect, laneRect } from "./geometry";
import { drawClipOutline } from "./ghosts";
import type { ArrangementScene } from "./scene";

/** Below this cell width a subdivision line is moiré, not information. */
const MIN_LINE_SPACING_PX = 7;
/** Note miniatures are pointless below this clip height. */
const MIN_NOTE_LANE_PX = 14;
/** Hard cap on note miniatures per clip per frame (SS2's 60 fps budget). */
const MAX_NOTES_PER_CLIP = 512;

export interface LayerDeps {
  readonly scene: ArrangementScene;
  readonly theme: ArrangementTheme;
}

function visibleRowRange(frame: LayerFrame, rowCount: number): { lo: number; hi: number } {
  const rows = frame.viewport.visibleRows();
  return {
    lo: Math.max(0, Math.floor(rows.start)),
    hi: Math.min(rowCount - 1, Math.ceil(rows.end)),
  };
}

export function createArrangementGridLayer(deps: LayerDeps & { grid: Grid }): EditorLayer {
  return {
    kind: "grid",
    draw(frame: LayerFrame): void {
      const { ctx, viewport, widthPx, heightPx } = frame;
      const { theme, scene } = deps;
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, widthPx, heightPx);

      // Lanes.
      const { lo, hi } = visibleRowRange(frame, scene.rowCount());
      for (let row = lo; row <= hi; row += 1) {
        const rect = laneRect(viewport, row, widthPx);
        const isTrack = scene.isTrackRow(row);
        ctx.fillStyle = isTrack ? (row % 2 === 0 ? theme.laneEven : theme.laneOdd) : theme.laneNonTrack;
        ctx.fillRect(0, alignPixel(rect.y), widthPx, alignPixel(rect.h));
        ctx.strokeStyle = theme.laneBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, alignHalfPixel(rect.y + rect.h));
        ctx.lineTo(widthPx, alignHalfPixel(rect.y + rect.h));
        ctx.stroke();
      }

      // Time lines, finest first so bar lines paint last and win.
      const signature = scene.doc.timeSignature;
      const bar = ticksPerBar(signature);
      const beat = ticksPerBeat(signature);
      const cell = deps.grid.gridTicks();
      const window = viewport.visibleTicks();
      const line = (tick: Ticks): void => {
        const x = alignHalfPixel(viewport.xOf(tick));
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, heightPx);
        ctx.stroke();
      };
      const rung = (step: Ticks, color: string): void => {
        if (step <= 0 || step * viewport.pxPerTick < MIN_LINE_SPACING_PX) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        const first = Math.floor(window.start / step) * step;
        for (let tick = first; tick <= window.end; tick += step) {
          if (tick % bar === 0) continue;
          line(tick);
        }
      };
      rung(cell, theme.gridLine);
      rung(beat, theme.beatLine);
      ctx.strokeStyle = theme.barLine;
      ctx.lineWidth = 1;
      const firstBar = Math.floor(window.start / bar) * bar;
      for (let tick = firstBar; tick <= window.end; tick += bar) line(tick);
    },
  };
}

function clipColor(scene: ArrangementScene, clip: ClipView, theme: ArrangementTheme): string {
  const own = clip.color;
  if (own !== undefined && own !== null && own !== "") return own;
  const channel = scene.doc.channels[clip.trackId]?.color;
  if (channel !== undefined && channel !== null && channel !== "") return channel;
  return theme.clipFill;
}

/**
 * Per-notes-array facts the miniature needs but must not re-derive per frame:
 * the pitch range the vertical scale maps (it has to stay stable while the
 * user scrolls, so it cannot be computed from the VISIBLE notes) and the
 * longest note, which bounds how far left of the window a note can start and
 * still be on screen. The store shares note arrays structurally, so array
 * identity is the cheapest possible dirty flag (same trick as the piano
 * roll's content layer).
 */
interface NoteFacts {
  readonly lowest: number;
  readonly highest: number;
  readonly maxDur: Ticks;
}
const noteFacts = new WeakMap<object, NoteFacts>();

function factsOf(notes: ClipView["notes"]): NoteFacts {
  const cached = noteFacts.get(notes);
  if (cached !== undefined) return cached;
  let lowest = 127;
  let highest = 0;
  let maxDur = 0;
  for (const note of notes) {
    if (note.pitch < lowest) lowest = note.pitch;
    if (note.pitch > highest) highest = note.pitch;
    if (note.dur > maxDur) maxDur = note.dur;
  }
  const facts: NoteFacts = { lowest, highest, maxDur };
  noteFacts.set(notes, facts);
  return facts;
}

/** First index whose `start` is >= `tick`; notes are sorted by start
 *  (./document.ts invariant 4), so this is SS9's binary search. */
function firstNoteAtOrAfter(notes: ClipView["notes"], tick: Ticks): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((notes[mid]?.start ?? 0) >= tick) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function drawNotes(frame: LayerFrame, theme: ArrangementTheme, clip: ClipView, x: number, y: number, w: number, h: number): void {
  const notes = clip.notes;
  if (notes.length === 0 || h < MIN_NOTE_LANE_PX) return;
  const { lowest, highest, maxDur } = factsOf(notes);
  const span = Math.max(1, highest - lowest + 1);
  const top = y + 3;
  const usable = h - 6;
  const rowH = Math.max(1, usable / span);
  const { ctx, viewport } = frame;
  ctx.fillStyle = theme.clipNote;

  // SS9: "the visible window is found by binary search — O(visible) per
  // frame". The window is intersected with the clip, in CLIP-RELATIVE ticks;
  // a prefix scan of the first N notes would both cost more and draw the
  // wrong notes once the user scrolls past note N.
  const window = viewport.visibleTicks();
  const from = Math.max(0, window.start - clip.start - maxDur);
  const to = Math.min(clip.length, window.end - clip.start);
  if (to <= 0) return;
  let drawn = 0;
  for (let i = firstNoteAtOrAfter(notes, from); i < notes.length; i += 1) {
    const note = notes[i];
    if (note === undefined) continue;
    if (note.start > to) break;
    const nx = x + note.start * viewport.pxPerTick;
    const nw = Math.max(1, note.dur * viewport.pxPerTick);
    if (nx > x + w || nx + nw < x) continue;
    const ny = top + (highest - note.pitch) * rowH;
    ctx.fillRect(
      alignPixel(Math.max(x, nx)),
      alignPixel(ny),
      Math.max(1, alignPixel(Math.min(nw, x + w - nx))),
      Math.max(1, Math.min(rowH, 3)),
    );
    drawn += 1;
    // Backstop for a pathological clip: even culled, a fully zoomed-out
    // window can hold more notes than the miniature can express.
    if (drawn >= MAX_NOTES_PER_CLIP) break;
  }
}

export function createArrangementClipsLayer(deps: LayerDeps): EditorLayer {
  const scratch: ClipView[] = [];
  return {
    kind: "content",
    draw(frame: LayerFrame): void {
      const { ctx, viewport, widthPx } = frame;
      const { scene, theme } = deps;
      const window = viewport.visibleTicks();
      const { lo, hi } = visibleRowRange(frame, scene.rowCount());
      const brace = braceHeightPx(viewport);

      for (let row = lo; row <= hi; row += 1) {
        scratch.length = 0;
        scene.clipsInRange(row, window.start, window.end, scratch);
        for (const clip of scratch) {
          const rect = clipRect(viewport, row, clip.start, clip.length);
          const x = alignPixel(rect.x);
          const y = alignPixel(rect.y);
          const w = Math.max(1, alignPixel(rect.w));
          const h = Math.max(1, alignPixel(rect.h));
          ctx.fillStyle = clipColor(scene, clip, theme);
          ctx.fillRect(x, y, w, h);

          // Loop unrolling, drawn as repeat separators so the brace explains
          // what the player will do with the content.
          const loop = clip.loop;
          if (loop !== undefined && loop !== null && loop.end > loop.start) {
            const period = loop.end - loop.start;
            // Same two rules as every other line loop in this file: skip the
            // whole rung when the repeats are closer than a readable spacing
            // (a 1-tick loop is reachable with one drag of the loop handle),
            // and ITERATE only over the visible window rather than the clip's
            // whole length — SS9's "O(visible) per frame".
            if (period * viewport.pxPerTick >= MIN_LINE_SPACING_PX) {
              const firstVisible = window.start - clip.start;
              const repeats = Math.max(0, Math.ceil((firstVisible - loop.end) / period));
              const lastVisible = Math.min(clip.length, window.end - clip.start);
              ctx.strokeStyle = theme.clipRepeatLine;
              ctx.lineWidth = 1;
              for (let t = loop.end + repeats * period; t < lastVisible; t += period) {
                const rx = alignHalfPixel(viewport.xOf(clip.start + t));
                if (rx < 0 || rx > widthPx) continue;
                ctx.beginPath();
                ctx.moveTo(rx, y);
                ctx.lineTo(rx, y + h);
                ctx.stroke();
              }
            }
          }

          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          drawNotes(frame, theme, clip, rect.x, rect.y, rect.w, rect.h);

          if (loop !== undefined && loop !== null) {
            const bx = viewport.xOf(clip.start + loop.start);
            const bw = Math.max(1, (loop.end - loop.start) * viewport.pxPerTick);
            ctx.fillStyle = theme.clipLoopBrace;
            ctx.fillRect(alignPixel(bx), y, alignPixel(bw), Math.max(2, alignPixel(brace)));
          }

          if (h >= MIN_NOTE_LANE_PX) {
            const label = clip.name ?? scene.doc.channels[clip.trackId]?.name ?? "";
            if (label !== "") {
              ctx.fillStyle = theme.clipText;
              ctx.font = "11px system-ui, sans-serif";
              ctx.textBaseline = "top";
              ctx.fillText(label, x + 4, y + (brace > 0 && clip.loop ? brace + 2 : 3));
            }
          }
          ctx.restore();

          ctx.strokeStyle = theme.clipBorder;
          ctx.lineWidth = 1;
          ctx.strokeRect(alignHalfPixel(rect.x), alignHalfPixel(rect.y), w, h);
        }
      }
    },
  };
}

export interface OverlayDeps extends LayerDeps {
  readonly selection: SelectionModel<ClipId>;
  hoveredClipId(): ClipId | null;
}

/** Drawn UNDER the active handler's ghosts by the kit's overlay layer. */
export function drawSelectionAndHover(frame: LayerFrame, deps: OverlayDeps): void {
  const { scene, theme, selection } = deps;
  const hovered = deps.hoveredClipId();
  if (hovered !== null && !selection.has(hovered)) {
    const clip = scene.clip(hovered);
    const row = clip === undefined ? -1 : scene.rowOfClip(clip.id);
    if (clip !== undefined && row >= 0) {
      drawClipOutline(frame, row, clip.start, clip.length, theme.hoverOutline, 1);
    }
  }
  for (const id of selection.ids()) {
    const clip = scene.clip(id);
    if (clip === undefined) continue;
    const row = scene.rowOfClip(id);
    if (row < 0) continue;
    drawClipOutline(frame, row, clip.start, clip.length, theme.selectionOutline, 2);
  }
}
