// SS8 — "Conversion happens in exactly two places: the scheduler (ticks ->
// AudioContext seconds) and THE TIME RULER (formatting bar.beat.tick)."
//
// This is that second place. The ruler owns:
//   * bar / beat lines with `bar.beat.tick` labels, from the document's time
//     signature (`../../time` does the arithmetic; nothing is re-derived here);
//   * the transport readout, which is the only thing in the whole editor that
//     touches seconds — via a `TempoMap` built from `Project.tempo`;
//   * click / drag to seek, snapped through the same `Grid` the lanes use.
//
// It draws on its own small canvas and moves a DOM playhead marker, so the
// lane canvases are never invalidated by playback (SS9's playhead rule).

import type { ProjectSnapshot } from "../../types/commands";
import type { Modifiers } from "../../types/gesture";
import type { TempoMap, Ticks } from "../../types/time";
import type { LoopRegion } from "../../types/transport";
import type { Grid, Viewport } from "../../types/viewport";
import { createTempoMap, formatBarBeatTick, tickToBarBeatTick, ticksPerBar, ticksPerBeat } from "../../time";
import { alignHalfPixel, modifiersOf, snapCreateTick } from "../kit";
import type { ArrangementTheme } from "./constants";
import {
  LOOP_BAND_HEIGHT_PX,
  LOOP_DRAG_THRESHOLD_PX,
  LOOP_EDGE_GRAB_PX,
  RULER_HEIGHT_PX,
} from "./constants";

/** Minimum horizontal room a `bar.beat.tick` label needs, in CSS pixels. */
const MIN_LABEL_SPACING_PX = 56;

export interface RulerOptions {
  container: HTMLElement;
  viewport: Viewport;
  grid: Grid;
  theme: ArrangementTheme;
  doc: ProjectSnapshot;
  /** Element the `bar.beat.tick` + seconds readout is written into. */
  readout?: HTMLElement | undefined;
  onSeek?: ((tick: Ticks) => void) | undefined;
  /** SS12 transport loop: the ruler's top band edits `Project.loop`. One
   *  call per completed gesture, so a drag is ONE undo entry (SS9: preview
   *  while dragging, dispatch once at the end). */
  onSetLoop?: ((loop: LoopRegion) => void) | undefined;
  dpr?: number | undefined;
}

/** Which part of the loop brace a press in the loop band landed on. */
export type LoopGrab = "start" | "end" | "body" | "empty";

/** Hit test for the loop band, in CSS pixels along the ruler. */
export function loopGrabAt(
  xPx: number,
  loop: { start: Ticks; end: Ticks },
  xOf: (tick: Ticks) => number,
): LoopGrab {
  const left = xOf(loop.start);
  const right = xOf(loop.end);
  if (right <= left) return "empty";
  if (Math.abs(xPx - left) <= LOOP_EDGE_GRAB_PX) return "start";
  if (Math.abs(xPx - right) <= LOOP_EDGE_GRAB_PX) return "end";
  if (xPx > left && xPx < right) return "body";
  return "empty";
}

export interface RulerView {
  readonly element: HTMLElement;
  setDocument(doc: ProjectSnapshot): void;
  setPlayheadTicks(tick: Ticks): void;
  /** Redraws now (the app never needs this; tests and resizes do). */
  redraw(): void;
  resize(widthPx: number): void;
  dispose(): void;
}

/** `m:ss.mmm` — the readout half of SS8's ruler conversion. */
export function formatSeconds(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = clamped - minutes * 60;
  const whole = Math.floor(rest);
  const millis = Math.round((rest - whole) * 1000);
  return `${String(minutes)}:${String(whole).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Label step in ticks: whole bars, thinned out until labels stop colliding. */
export function labelStepTicks(barTicks: Ticks, pxPerTick: number): Ticks {
  const perBar = barTicks * pxPerTick;
  if (perBar <= 0) return barTicks;
  const bars = Math.max(1, Math.ceil(MIN_LABEL_SPACING_PX / perBar));
  return barTicks * bars;
}

export function createRuler(options: RulerOptions): RulerView {
  const { viewport, grid, theme } = options;
  let doc = options.doc;
  let tempo: TempoMap = createTempoMap(doc.tempo);
  let playhead: Ticks = 0;
  let lastReadout = "";
  let disposed = false;

  const element = document.createElement("div");
  element.className = "fbl-arr-ruler";
  element.style.position = "relative";
  element.style.height = `${String(RULER_HEIGHT_PX)}px`;
  element.style.overflow = "hidden";
  element.style.background = theme.rulerBackground;
  element.style.touchAction = "none";
  element.style.cursor = "text";
  options.container.appendChild(element);

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.pointerEvents = "none";
  element.appendChild(canvas);

  const marker = document.createElement("div");
  marker.className = "fbl-arr-ruler-playhead";
  marker.style.position = "absolute";
  marker.style.top = "0";
  marker.style.left = "0";
  marker.style.width = "1px";
  marker.style.height = "100%";
  marker.style.background = theme.playhead;
  marker.style.pointerEvents = "none";
  marker.style.willChange = "transform";
  element.appendChild(marker);

  const ctx = canvas.getContext("2d");
  const dpr = options.dpr ?? (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  let widthPx = 0;

  const applySize = (): void => {
    const width = Math.max(1, Math.round(widthPx * dpr));
    const height = Math.max(1, Math.round(RULER_HEIGHT_PX * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `${String(widthPx)}px`;
    canvas.style.height = `${String(RULER_HEIGHT_PX)}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const positionMarker = (): void => {
    marker.style.transform = `translateX(${String(Math.round(viewport.xOf(playhead)))}px)`;
  };

  const writeReadout = (): void => {
    const target = options.readout;
    if (target === undefined) return;
    const text = `${formatBarBeatTick(tickToBarBeatTick(playhead, doc.timeSignature))}  ${formatSeconds(
      tempo.secondsAt(playhead),
    )}`;
    if (text === lastReadout) return;
    lastReadout = text;
    target.textContent = text;
  };

  const draw = (): void => {
    if (ctx === null || disposed) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.rulerBackground;
    ctx.fillRect(0, 0, widthPx, RULER_HEIGHT_PX);

    const signature = doc.timeSignature;
    const bar = ticksPerBar(signature);
    const beat = ticksPerBeat(signature);
    const window = viewport.visibleTicks();

    ctx.strokeStyle = theme.rulerLine;
    ctx.lineWidth = 1;
    if (beat * viewport.pxPerTick >= 6) {
      const firstBeat = Math.floor(window.start / beat) * beat;
      for (let tick = firstBeat; tick <= window.end; tick += beat) {
        if (tick % bar === 0) continue;
        const x = alignHalfPixel(viewport.xOf(tick));
        ctx.beginPath();
        ctx.moveTo(x, RULER_HEIGHT_PX - 6);
        ctx.lineTo(x, RULER_HEIGHT_PX);
        ctx.stroke();
      }
    }

    // --- transport loop brace (SS12) ---
    const shown = pendingLoop ?? doc.loop;
    if (shown.end > shown.start) {
      const x0 = viewport.xOf(shown.start);
      const x1 = viewport.xOf(shown.end);
      ctx.fillStyle = shown.enabled ? theme.loopBrace : theme.loopBraceOff;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), LOOP_BAND_HEIGHT_PX);
      ctx.fillStyle = theme.loopHandle;
      ctx.fillRect(alignHalfPixel(x0) - 0.5, 0, 2, LOOP_BAND_HEIGHT_PX);
      ctx.fillRect(alignHalfPixel(x1) - 1.5, 0, 2, LOOP_BAND_HEIGHT_PX);
    }

    const step = labelStepTicks(bar, viewport.pxPerTick);
    const first = Math.floor(window.start / step) * step;
    ctx.fillStyle = theme.rulerText;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "top";
    for (let tick = first; tick <= window.end; tick += step) {
      if (tick < 0) continue;
      const x = alignHalfPixel(viewport.xOf(tick));
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, RULER_HEIGHT_PX);
      ctx.stroke();
      // SS8's format, straight from ../../time — never re-implemented here.
      ctx.fillText(formatBarBeatTick(tickToBarBeatTick(tick, signature)), x + 4, 4);
    }
    ctx.restore();
  };

  let frame: number | null = null;
  const schedule = (): void => {
    if (disposed) return;
    if (typeof requestAnimationFrame !== "function") {
      draw();
      return;
    }
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      draw();
    });
  };

  const unsubscribe = viewport.onChange(() => {
    positionMarker();
    schedule();
  });
  const unsubscribeGrid = grid.onChange(() => {
    schedule();
  });

  // --- seeking --------------------------------------------------------------

  const seekTo = (clientX: number, mods: Modifiers): void => {
    const seek = options.onSeek;
    if (seek === undefined) return;
    const rect = element.getBoundingClientRect();
    const tick = viewport.tAt(clientX - rect.left);
    seek(Math.max(0, snapCreateTick(grid, tick, mods, "nearest")));
  };

  // --- transport loop brace -------------------------------------------------
  //
  // The ruler's TOP band edits the loop; everything below it still seeks, so
  // the two gestures never compete for the same pixel. The whole drag is a
  // preview (`pendingLoop`) and lands as ONE `setLoopRegion` on release —
  // the same discipline the kit's gesture engine applies to note drags.

  let pendingLoop: LoopRegion | null = null;
  /** The live loop gesture, or `null` while the ruler is only seeking. */
  let loopDrag:
    | { grab: LoopGrab; anchorTick: Ticks; startX: number; moved: boolean; base: LoopRegion }
    | null = null;

  const localX = (clientX: number): number => clientX - element.getBoundingClientRect().left;

  const snapped = (xPx: number, mods: Modifiers): Ticks =>
    Math.max(0, snapCreateTick(grid, viewport.tAt(xPx), mods, "nearest"));

  const inLoopBand = (event: PointerEvent): boolean => {
    const rect = element.getBoundingClientRect();
    return event.clientY - rect.top <= LOOP_BAND_HEIGHT_PX;
  };

  const updateLoopDrag = (event: PointerEvent): void => {
    if (loopDrag === null) return;
    const x = localX(event.clientX);
    if (!loopDrag.moved && Math.abs(x - loopDrag.startX) > LOOP_DRAG_THRESHOLD_PX) {
      loopDrag.moved = true;
    }
    if (!loopDrag.moved) return;
    const mods = modifiersOf(event);
    const tick = snapped(x, mods);
    const base = loopDrag.base;
    if (loopDrag.grab === "body") {
      const delta = tick - loopDrag.anchorTick;
      const length = base.end - base.start;
      const start = Math.max(0, base.start + delta);
      pendingLoop = { start, end: start + length, enabled: base.enabled };
    } else if (loopDrag.grab === "start") {
      pendingLoop = { start: Math.min(tick, base.end - 1), end: base.end, enabled: base.enabled };
    } else if (loopDrag.grab === "end") {
      pendingLoop = { start: base.start, end: Math.max(tick, base.start + 1), enabled: base.enabled };
    } else {
      // Dragging empty band DEFINES a region, and a region drawn on purpose
      // is meant to be used — so this is the one gesture that also enables.
      const from = Math.min(loopDrag.anchorTick, tick);
      const to = Math.max(loopDrag.anchorTick, tick);
      pendingLoop = { start: from, end: Math.max(to, from + 1), enabled: true };
    }
    schedule();
  };

  const endLoopDrag = (): void => {
    const drag = loopDrag;
    loopDrag = null;
    if (drag === null) return;
    const setLoop = options.onSetLoop;
    if (setLoop === undefined) {
      pendingLoop = null;
      schedule();
      return;
    }
    if (!drag.moved) {
      // A click inside the brace toggles looping; a click on empty band is
      // deliberately inert (a zero-length loop would be a trap).
      pendingLoop = null;
      if (drag.grab !== "empty") setLoop({ ...drag.base, enabled: !drag.base.enabled });
      schedule();
      return;
    }
    const next = pendingLoop;
    pendingLoop = null;
    if (next !== null) setLoop(next);
    schedule();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers have nothing to capture.
    }
    if (options.onSetLoop !== undefined && inLoopBand(event)) {
      const x = localX(event.clientX);
      const base = doc.loop;
      loopDrag = {
        grab: loopGrabAt(x, base, (tick) => viewport.xOf(tick)),
        anchorTick: snapped(x, modifiersOf(event)),
        startX: x,
        moved: false,
        base: { ...base },
      };
      return;
    }
    seekTo(event.clientX, modifiersOf(event));
  };
  const onPointerMove = (event: PointerEvent): void => {
    if ((event.buttons & 1) === 0) return;
    if (loopDrag !== null) {
      updateLoopDrag(event);
      return;
    }
    seekTo(event.clientX, modifiersOf(event));
  };
  const onPointerUp = (): void => {
    endLoopDrag();
  };
  const onPointerCancel = (): void => {
    loopDrag = null;
    pendingLoop = null;
    schedule();
  };
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerCancel);

  applySize();
  positionMarker();
  writeReadout();
  draw();

  return {
    element,
    setDocument(next: ProjectSnapshot): void {
      const tempoChanged = next.tempo !== doc.tempo;
      const loopChanged = next.loop !== doc.loop;
      doc = next;
      if (loopChanged) schedule();
      if (tempoChanged) tempo = createTempoMap(doc.tempo);
      writeReadout();
      schedule();
    },
    setPlayheadTicks(tick: Ticks): void {
      if (tick === playhead) return;
      playhead = tick;
      positionMarker();
      writeReadout();
    },
    redraw(): void {
      draw();
    },
    resize(nextWidthPx: number): void {
      if (nextWidthPx === widthPx) return;
      widthPx = Math.max(0, nextWidthPx);
      applySize();
      draw();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      unsubscribe();
      unsubscribeGrid();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerCancel);
      element.remove();
    },
  };
}
