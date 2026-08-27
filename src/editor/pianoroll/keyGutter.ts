// SS10 — the key strip down the left of the note grid.
//
// It is its OWN canvas, in its own grid cell beside the editor canvas — the
// same shape the arrangement uses for its lane headers, and for the same
// reason. Drawing key names as an overlay on the note canvas would put them
// on top of any note near tick 0, and clipping the notes instead would hide
// the first bar of the clip; a real gutter takes its width out of the
// editor's, so notes and names can never occupy the same pixel.
//
// Nothing here is a hit target: pitch still comes from `pitchAtY` on the
// note canvas, so no geometry, hit test or drag handler knows the gutter
// exists.

import type { Viewport } from "../../types/viewport";
import { alignPixel } from "../kit/renderer";
import {
  KEY_GUTTER_WIDTH_PX,
  KEY_LABEL_MIN_ROW_PX,
  isBlackKeyPitch,
  noteName,
} from "./keyNames";
import { MAX_PITCH, MIN_PITCH, rowOfPitch, type PianoRollLayout } from "./layout";
import type { PianoRollTheme } from "./theme";

export interface KeyGutterOptions {
  container: HTMLElement;
  viewport: Viewport;
  layout: PianoRollLayout;
  theme: PianoRollTheme;
  dpr?: number | undefined;
}

export interface KeyGutter {
  readonly element: HTMLCanvasElement;
  /** Redraw at the current scroll/zoom. Cheap: bounded by visible rows. */
  draw(): void;
  dispose(): void;
}

export function createKeyGutter(options: KeyGutterOptions): KeyGutter {
  const { viewport, layout, theme } = options;
  const canvas = document.createElement("canvas");
  canvas.className = "fbl-key-gutter";
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  options.container.appendChild(canvas);

  const dpr = options.dpr ?? (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

  const draw = (): void => {
    // Size from the FRACTIONAL rect, as the kit's renderer does: a cell
    // 189.5 css px tall needs a 379-device-pixel backing store at dpr 2, and
    // `clientHeight` (rounded to 189) would give 378 — a half-pixel blur, and
    // exactly what the dpr e2e probe measures.
    const rect = options.container.getBoundingClientRect();
    const width = rect.width || options.container.clientWidth || KEY_GUTTER_WIDTH_PX;
    const height = rect.height || options.container.clientHeight || viewport.heightPx;
    if (width <= 0 || height <= 0) return;
    const deviceW = Math.max(1, Math.round(width * dpr));
    const deviceH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== deviceW) canvas.width = deviceW;
    if (canvas.height !== deviceH) canvas.height = deviceH;
    const c = canvas.getContext("2d");
    if (c === null) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);

    // Ruler and velocity-lane rows have no key, so they take the ruler's own
    // background and the strip reads as one column with the editor.
    c.fillStyle = theme.rulerBackground;
    c.fillRect(0, 0, width, height);

    c.save();
    c.beginPath();
    c.rect(0, layout.noteTopPx, width, layout.noteBottomPx - layout.noteTopPx);
    c.clip();

    const rows = viewport.visibleRows();
    const first = Math.max(rowOfPitch(MAX_PITCH), Math.floor(rows.start));
    const last = Math.min(rowOfPitch(MIN_PITCH), Math.ceil(rows.end));
    const labelEveryRow = viewport.pxPerRow >= KEY_LABEL_MIN_ROW_PX;
    c.font = theme.keyGutterFont;
    c.textBaseline = "middle";
    c.textAlign = "right";

    for (let row = first; row <= last; row += 1) {
      const pitch = MAX_PITCH - row;
      const y = viewport.yOf(row) + layout.noteTopPx;
      const h = Math.ceil(viewport.pxPerRow);
      const black = isBlackKeyPitch(pitch);
      c.fillStyle = black ? theme.keyGutterBlack : theme.keyGutterWhite;
      c.fillRect(0, alignPixel(y), width, h);
      if (viewport.pxPerRow >= 4) {
        c.fillStyle = theme.keyGutterLine;
        c.fillRect(0, alignPixel(y), width, 1);
      }
      // Zoomed out, only each octave's C is labelled — enough to keep your
      // bearings without stacking unreadable text.
      if (labelEveryRow || pitch % 12 === 0) {
        c.fillStyle = black ? theme.keyGutterTextBlack : theme.keyGutterText;
        c.fillText(noteName(pitch), width - 3, alignPixel(y) + h / 2);
      }
    }
    c.restore();

    c.fillStyle = theme.keyGutterLine;
    c.fillRect(width - 1, 0, 1, height);
  };

  const unsub = viewport.onChange(() => draw());
  draw();

  return {
    element: canvas,
    draw,
    dispose(): void {
      unsub();
      canvas.remove();
    },
  };
}
