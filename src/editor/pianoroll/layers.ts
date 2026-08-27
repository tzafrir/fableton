// SS9's rendering stack, piano-roll skin. Redraw triggers are the frozen ones:
//
//   grid    — viewport change only (rows, bar/beat lines, ruler, lane chrome)
//   content — data or viewport change (notes + velocity stalks)
//   overlay — selection, marquee, drag ghosts; the ONLY per-frame layer
//
// Culling is SS9's: "notes are kept sorted by start tick, and the visible
// window is found by binary search — O(visible) per frame". The content layer
// keeps a `TickIndex` and rebuilds it only when the store hands out a new
// notes array (structural sharing makes identity the cheapest dirty flag).
//
// Layers draw in CSS pixels; the renderer already applied `dpr`. Hairlines go
// through the kit's `alignHalfPixel` so nothing shimmers.

import type { EditorLayer, LayerFrame, TickIndex } from "../../types/render";
import type { Ticks } from "../../types/time";
import { ticksPerBar, ticksPerBeat } from "../../time";
import { alignHalfPixel, alignPixel } from "../kit/renderer";
import { createTickIndex } from "../kit/tickIndex";
import type { ContextRef, PianoRollContext } from "./context";
import {
  MAX_PITCH,
  MIN_PITCH,
  noteRect,
  rowOfPitch,
  stalkX,
  yOfPitch,
  yOfVelocity,
  type RONote,
} from "./layout";
import { ghostsOf, type PianoRollPreview } from "./preview";
import { DEFAULT_PIANO_ROLL_THEME, type PianoRollTheme } from "./theme";

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function isBlackKey(pitch: number): boolean {
  return BLACK_KEYS.has(((pitch % 12) + 12) % 12);
}

/** Vertical line, half-pixel aligned. */
function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number): void {
  const px = alignHalfPixel(x);
  ctx.beginPath();
  ctx.moveTo(px, y0);
  ctx.lineTo(px, y1);
  ctx.stroke();
}

function hline(ctx: CanvasRenderingContext2D, y: number, x0: number, x1: number): void {
  const py = alignHalfPixel(y);
  ctx.beginPath();
  ctx.moveTo(x0, py);
  ctx.lineTo(x1, py);
  ctx.stroke();
}

/** Clips subsequent drawing to the note grid (never the ruler or the lane). */
function clipToNoteArea(frame: LayerFrame, ctx: PianoRollContext): void {
  const c = frame.ctx;
  c.beginPath();
  c.rect(0, ctx.layout.noteTopPx, frame.widthPx, ctx.layout.noteBottomPx - ctx.layout.noteTopPx);
  c.clip();
}

// --- grid -------------------------------------------------------------------

export function createPianoRollGridLayer(
  ref: ContextRef,
  theme: PianoRollTheme = DEFAULT_PIANO_ROLL_THEME,
): EditorLayer {
  return {
    kind: "grid",
    draw(frame: LayerFrame): void {
      const ctx = ref();
      const c = frame.ctx;
      const { viewport, layout } = ctx;
      const noteTop = layout.noteTopPx;
      const noteBottom = layout.noteBottomPx;

      c.save();
      c.fillStyle = theme.background;
      c.fillRect(0, 0, frame.widthPx, frame.heightPx);

      // --- rows (pitch lanes) ---
      c.save();
      clipToNoteArea(frame, ctx);
      const rows = viewport.visibleRows();
      const first = Math.max(rowOfPitch(MAX_PITCH), Math.floor(rows.start));
      const last = Math.min(rowOfPitch(MIN_PITCH), Math.ceil(rows.end));
      for (let row = first; row <= last; row += 1) {
        const pitch = MAX_PITCH - row;
        const y = viewport.yOf(row) + noteTop;
        c.fillStyle = isBlackKey(pitch) ? theme.rowBlack : theme.rowWhite;
        c.fillRect(0, alignPixel(y), frame.widthPx, Math.ceil(viewport.pxPerRow));
      }
      if (viewport.pxPerRow >= 6) {
        c.lineWidth = 1;
        for (let row = first; row <= last + 1; row += 1) {
          const pitch = MAX_PITCH - row;
          // The line ABOVE row `row`; an octave boundary sits above every C.
          c.strokeStyle = pitch % 12 === 11 ? theme.octaveLine : theme.rowLine;
          hline(c, viewport.yOf(row) + noteTop, 0, frame.widthPx);
        }
      }

      // --- time lines ---
      const doc = ctx.store.getState();
      const sig = { numerator: doc.timeSignature.numerator, denominator: doc.timeSignature.denominator };
      const bar = ticksPerBar(sig);
      const beat = ticksPerBeat(sig);
      const division = Math.max(1, ctx.grid.gridTicks());
      const window = viewport.visibleTicks();

      const drawLines = (step: Ticks, color: string): void => {
        if (step <= 0 || step * viewport.pxPerTick < 4) return;
        c.strokeStyle = color;
        c.lineWidth = 1;
        const from = Math.floor(window.start / step) * step;
        for (let t = from; t <= window.end; t += step) {
          vline(c, viewport.xOf(t), noteTop, noteBottom);
        }
      };
      drawLines(division, theme.gridLine);
      drawLines(beat, theme.beatLine);
      drawLines(bar, theme.barLine);

      // --- past the end of the clip ---
      const length = ctx.clipLength();
      if (length > 0) {
        const x = viewport.xOf(length);
        if (x < frame.widthPx) {
          c.fillStyle = theme.outsideClip;
          c.fillRect(x, noteTop, frame.widthPx - x, noteBottom - noteTop);
        }
      }
      c.restore();

      // --- ruler ---
      if (layout.rulerHeightPx > 0) {
        c.fillStyle = theme.rulerBackground;
        c.fillRect(0, 0, frame.widthPx, layout.rulerHeightPx);
        c.strokeStyle = theme.rulerLine;
        c.lineWidth = 1;
        hline(c, layout.rulerHeightPx, 0, frame.widthPx);
        c.fillStyle = theme.rulerText;
        c.font = theme.rulerFont;
        c.textBaseline = "middle";
        c.textAlign = "left";
        if (bar * viewport.pxPerTick >= 24) {
          const fromBar = Math.floor(window.start / bar) * bar;
          for (let t = fromBar; t <= window.end; t += bar) {
            const x = viewport.xOf(t);
            vline(c, x, layout.rulerHeightPx - 5, layout.rulerHeightPx);
            c.fillText(String(Math.floor(t / bar) + 1), x + 3, layout.rulerHeightPx / 2);
          }
        }
      }

      // --- velocity lane chrome ---
      if (layout.velocityLaneHeightPx > 0) {
        c.fillStyle = theme.velocityBackground;
        c.fillRect(0, layout.velocityTopPx, frame.widthPx, layout.velocityLaneHeightPx);
        c.strokeStyle = theme.velocityBorder;
        c.lineWidth = 1;
        hline(c, layout.velocityTopPx, 0, frame.widthPx);
      }

      c.restore();
    },
  };
}

// --- content ----------------------------------------------------------------

export function createPianoRollContentLayer(
  ref: ContextRef,
  theme: PianoRollTheme = DEFAULT_PIANO_ROLL_THEME,
): EditorLayer {
  const index: TickIndex<RONote> = createTickIndex<RONote>((note) => ({
    start: note.start,
    end: note.start + note.dur,
  }));
  let indexed: readonly RONote[] | null = null;
  const visible: RONote[] = [];

  return {
    kind: "content",
    draw(frame: LayerFrame): void {
      const ctx = ref();
      const notes = ctx.notes();
      if (notes !== indexed) {
        index.rebuild(notes);
        indexed = notes;
      }
      const window = ctx.viewport.visibleTicks();
      visible.length = 0;
      index.inRange(window.start, window.end, visible);

      const c = frame.ctx;
      const { viewport, layout } = ctx;

      c.save();
      c.save();
      clipToNoteArea(frame, ctx);
      c.lineWidth = 1;
      for (const note of visible) {
        const rect = noteRect(viewport, layout, note);
        if (rect.y > layout.noteBottomPx || rect.y + rect.h < layout.noteTopPx) continue;
        const w = Math.max(2, rect.w);
        c.fillStyle = note.muted === true ? theme.noteMutedFill : theme.noteFill;
        // Velocity reads as opacity, the way it does in every DAW.
        c.globalAlpha = 0.45 + 0.55 * (note.vel / 127);
        c.fillRect(alignPixel(rect.x), alignPixel(rect.y), Math.max(2, alignPixel(w)), Math.max(2, alignPixel(rect.h) - 1));
        c.globalAlpha = 1;
        c.strokeStyle = theme.noteStroke;
        c.strokeRect(
          alignHalfPixel(rect.x),
          alignHalfPixel(rect.y),
          Math.max(2, alignPixel(w)),
          Math.max(2, alignPixel(rect.h) - 1),
        );
      }
      c.restore();

      // --- velocity stalks (SS10: "each note draws a stalk") ---
      if (layout.velocityLaneHeightPx > 0) {
        c.save();
        c.beginPath();
        c.rect(0, layout.velocityTopPx, frame.widthPx, layout.velocityLaneHeightPx);
        c.clip();
        c.lineWidth = 2;
        for (const note of visible) {
          const x = stalkX(viewport, note);
          c.strokeStyle = ctx.selection.has(note.id)
            ? theme.velocityStalkSelected
            : theme.velocityStalk;
          vline(c, x, yOfVelocity(layout, note.vel), layout.velocityBottomPx);
        }
        c.restore();
      }

      c.restore();
    },
  };
}

// --- overlay ----------------------------------------------------------------

export interface PianoRollOverlayOptions {
  /** `() => host.gestures.preview` — the contract's "one big overlay layer"
   *  route (types/gesture: an editor may read `GestureEngine.preview`). */
  previewOf: () => unknown;
  theme?: PianoRollTheme | undefined;
}

export function createPianoRollOverlayLayer(
  ref: ContextRef,
  options: PianoRollOverlayOptions,
): EditorLayer {
  const theme = options.theme ?? DEFAULT_PIANO_ROLL_THEME;

  return {
    kind: "overlay",
    draw(frame: LayerFrame): void {
      const ctx = ref();
      const c = frame.ctx;
      const { viewport, layout } = ctx;
      const preview = options.previewOf() as PianoRollPreview | null;

      c.save();
      c.save();
      clipToNoteArea(frame, ctx);
      c.lineWidth = 1;

      // Selected notes (ephemeral state: overlay, never content).
      if (ctx.selection.size > 0) {
        const window = viewport.visibleTicks();
        for (const note of ctx.notes()) {
          if (!ctx.selection.has(note.id)) continue;
          if (note.start > window.end || note.start + note.dur < window.start) continue;
          const rect = noteRect(viewport, layout, note);
          c.fillStyle = theme.noteSelectedFill;
          c.fillRect(alignPixel(rect.x), alignPixel(rect.y), Math.max(2, alignPixel(rect.w)), Math.max(2, alignPixel(rect.h) - 1));
          c.strokeStyle = theme.noteSelectedStroke;
          c.strokeRect(
            alignHalfPixel(rect.x),
            alignHalfPixel(rect.y),
            Math.max(2, alignPixel(rect.w)),
            Math.max(2, alignPixel(rect.h) - 1),
          );
        }
      }

      // Drag ghosts (SS9: previews live here and nowhere else).
      const ghosts = ghostsOf(preview);
      if (ghosts.length > 0) {
        c.fillStyle = theme.ghostFill;
        c.strokeStyle = theme.ghostStroke;
        for (const ghost of ghosts) {
          const x = viewport.xOf(ghost.start);
          const y = yOfPitch(viewport, layout, ghost.pitch);
          const w = Math.max(2, ghost.dur * viewport.pxPerTick);
          const h = Math.max(2, viewport.pxPerRow - 1);
          c.fillRect(alignPixel(x), alignPixel(y), alignPixel(w), h);
          c.strokeRect(alignHalfPixel(x), alignHalfPixel(y), alignPixel(w), h);
        }
      }
      c.restore();

      if (preview !== null && typeof preview === "object") {
        if (preview.kind === "marquee") {
          c.fillStyle = theme.marqueeFill;
          c.strokeStyle = theme.marqueeStroke;
          c.lineWidth = 1;
          const { x0, y0, x1, y1 } = preview.rect;
          c.fillRect(x0, y0, x1 - x0, y1 - y0);
          c.strokeRect(alignHalfPixel(x0), alignHalfPixel(y0), alignPixel(x1 - x0), alignPixel(y1 - y0));
        } else if (preview.kind === "velocity" && layout.velocityLaneHeightPx > 0) {
          c.fillStyle = theme.velocitySweep;
          c.fillRect(
            preview.fromPx,
            layout.velocityTopPx,
            Math.max(1, preview.toPx - preview.fromPx),
            layout.velocityLaneHeightPx,
          );
        }
      }

      c.restore();
    },
  };
}

export interface PianoRollLayersOptions {
  previewOf: () => unknown;
  theme?: PianoRollTheme | undefined;
}

/** Bottom to top, as the renderer expects. */
export function createPianoRollLayers(
  ref: ContextRef,
  options: PianoRollLayersOptions,
): readonly EditorLayer[] {
  const theme = options.theme ?? DEFAULT_PIANO_ROLL_THEME;
  return [
    createPianoRollGridLayer(ref, theme),
    createPianoRollContentLayer(ref, theme),
    createPianoRollOverlayLayer(ref, { previewOf: options.previewOf, theme }),
  ];
}
