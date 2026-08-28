// The visualisers: a spectrum analyser and a level history, both tapped off
// the SELECTED channel's post-fader node — the same tap the SS6 meters read,
// so what is drawn here is exactly what that strip's meter is measuring.
//
// Canvas, not DOM: this repaints every frame, and SS5's "a few dozen live
// controls don't need canvas" is an argument about CONTROLS, not about a
// 2,000-pixel picture that changes 60 times a second.
//
// All the math is in ./scope/analysis.ts and unit-tested headlessly; this
// file owns only the paint. Nothing here touches the document (SS13:
// visualisation is ephemeral, never undoable, never saved).

import { useEffect, useRef } from "react";
import type { AppProjectEngine } from "../engine";
import type { ChannelId, ProjectSnapshot } from "../../types";
import { INK, SIGNAL, TEXT, alpha, CANVAS_FONT } from "../../ui/theme";
import {
  LevelHistory,
  MAX_DB,
  MAX_HZ,
  MIN_DB,
  MIN_HZ,
  amplitudeToHeight,
  levelOf,
  logPosition,
  spectrumBands,
} from "./scope/analysis";

export interface ScopePanelProps {
  engine: AppProjectEngine | null;
  doc: ProjectSnapshot;
  /** Which channel to look at; `null` falls back to the master bus. */
  channelId: ChannelId | null;
  /** Hidden panels stop painting entirely — see the `active` note below. */
  active: boolean;
}

/** Bars in the spectrum. Wide enough to read as a shape, narrow enough that
 *  each bar is a few pixels at a typical panel width. */
const BAND_COUNT = 96;
/** Frames of level history kept — about ten seconds at 60 fps. */
const HISTORY_FRAMES = 600;
/** Grid lines that carry a label, in Hz. */
const HZ_GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000] as const;
/** Horizontal grid on the level graph, in dBFS. */
const DB_GRID = [-6, -18, -36] as const;

function hzLabel(hz: number): string {
  return hz >= 1000 ? `${String(hz / 1000)}k` : String(hz);
}

function masterIdOf(doc: ProjectSnapshot): ChannelId | null {
  for (const id of doc.channelOrder) {
    if (doc.channels[id]?.role === "master") return id;
  }
  return null;
}

export function ScopePanel({ engine, doc, channelId, active }: ScopePanelProps) {
  const spectrumRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef<HTMLCanvasElement | null>(null);

  const target = channelId ?? masterIdOf(doc);
  const channelName = target === null ? "—" : (doc.channels[target]?.name ?? "—");

  useEffect(() => {
    // A hidden tab must not paint: the tab strip keeps this panel mounted so
    // its history survives a flip to the mixer and back, and a canvas that
    // repaints while nobody can see it is an FFT and a frame of layout per
    // vsync, spent on nothing.
    if (!active || engine === null || target === null) return;
    const analyser = engine.analyserFor(target);
    const spectrumCanvas = spectrumRef.current;
    const levelCanvas = levelRef.current;
    if (analyser === null || spectrumCanvas === null || levelCanvas === null) return;

    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    analyser.minDecibels = MIN_DB;
    analyser.maxDecibels = MAX_DB;

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Uint8Array(analyser.fftSize);
    // Typed `ArrayBuffer` explicitly: with COOP/COEP on (SS15), lib.dom types
    // `Float32Array` as `ArrayBufferLike`, which a `SharedArrayBuffer` also
    // satisfies — and `spectrumBands` returns a plain one.
    let bands: Float32Array<ArrayBuffer> = new Float32Array(BAND_COUNT);
    const history = new LevelHistory(HISTORY_FRAMES);
    const sampleRate = analyser.context.sampleRate;
    const fftSize = analyser.fftSize;

    /** Sizes a canvas to its CSS box in device pixels and returns its 2d
     *  context already scaled, or null if it has no box yet. */
    const prepare = (
      canvas: HTMLCanvasElement,
    ): { c: CanvasRenderingContext2D; w: number; h: number } | null => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || canvas.clientWidth;
      const h = rect.height || canvas.clientHeight;
      if (w <= 0 || h <= 0) return null;
      const dw = Math.max(1, Math.round(w * dpr));
      const dh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== dw) canvas.width = dw;
      if (canvas.height !== dh) canvas.height = dh;
      const c = canvas.getContext("2d");
      if (c === null) return null;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { c, w, h };
    };

    const drawSpectrum = (): void => {
      const prepared = prepare(spectrumCanvas);
      if (prepared === null) return;
      const { c, w, h } = prepared;
      c.clearRect(0, 0, w, h);
      c.fillStyle = INK.well;
      c.fillRect(0, 0, w, h);

      // Frequency grid first, so the bars sit on top of it.
      c.font = CANVAS_FONT.micro;
      c.textBaseline = "bottom";
      c.textAlign = "center";
      for (const hz of HZ_GRID) {
        const x = Math.round(logPosition(hz, MIN_HZ, MAX_HZ) * w) + 0.5;
        c.strokeStyle = INK.line;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h - 11);
        c.stroke();
        c.fillStyle = TEXT.faint;
        c.fillText(hzLabel(hz), x, h - 1);
      }

      bands = spectrumBands(freqData, sampleRate, fftSize, BAND_COUNT, bands);
      const floor = h - 12;
      const bandWidth = w / BAND_COUNT;
      const gradient = c.createLinearGradient(0, floor, 0, 0);
      gradient.addColorStop(0, SIGNAL.aquaDim);
      gradient.addColorStop(0.75, SIGNAL.aqua);
      gradient.addColorStop(1, SIGNAL.amber);
      c.fillStyle = gradient;
      for (let i = 0; i < BAND_COUNT; i++) {
        const value = bands[i] ?? 0;
        if (value <= 0) continue;
        const barHeight = value * floor;
        c.fillRect(i * bandWidth, floor - barHeight, Math.max(1, bandWidth - 1), barHeight);
      }
    };

    const drawLevels = (): void => {
      const prepared = prepare(levelCanvas);
      if (prepared === null) return;
      const { c, w, h } = prepared;
      c.clearRect(0, 0, w, h);
      c.fillStyle = INK.well;
      c.fillRect(0, 0, w, h);

      c.font = CANVAS_FONT.micro;
      c.textBaseline = "top";
      c.textAlign = "left";
      for (const db of DB_GRID) {
        const y = Math.round(h - amplitudeToHeight(10 ** (db / 20)) * h) + 0.5;
        c.strokeStyle = INK.line;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
        c.fillStyle = TEXT.faint;
        c.fillText(`${String(db)}`, 3, y + 2);
      }

      // Oldest sample at the left edge, newest at the right: time runs the
      // way it is read, and the newest value is the one under the playhead.
      const count = history.length;
      if (count === 0) return;
      const step = w / HISTORY_FRAMES;
      const xOf = (index: number): number => (index + (HISTORY_FRAMES - count)) * step;

      c.beginPath();
      c.moveTo(xOf(0), h);
      for (let i = 0; i < count; i++) {
        c.lineTo(xOf(i), h - amplitudeToHeight(history.at(i).peak) * h);
      }
      c.lineTo(xOf(count - 1), h);
      c.closePath();
      c.fillStyle = alpha(SIGNAL.aqua, 0.22);
      c.fill();

      c.beginPath();
      for (let i = 0; i < count; i++) {
        const y = h - amplitudeToHeight(history.at(i).rms) * h;
        if (i === 0) c.moveTo(xOf(i), y);
        else c.lineTo(xOf(i), y);
      }
      c.strokeStyle = SIGNAL.aqua;
      c.lineWidth = 1.5;
      c.stroke();
    };

    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);
      const level = levelOf(timeData);
      history.push(level.peak, level.rms);
      drawSpectrum();
      drawLevels();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, target, active]);

  return (
    <div className="fbl-scope" data-testid="scope-panel">
      <div className="fbl-scope-head">
        <span className="fbl-scope-title">Spectrum</span>
        <span className="fbl-scope-source" data-testid="scope-source">
          {channelName}
        </span>
      </div>
      <canvas ref={spectrumRef} className="fbl-scope-canvas" data-testid="scope-spectrum" />
      <div className="fbl-scope-head">
        <span className="fbl-scope-title">Level over time</span>
        <span className="fbl-scope-source">peak · rms, last ~10 s</span>
      </div>
      <canvas ref={levelRef} className="fbl-scope-canvas" data-testid="scope-level" />
      {engine === null && (
        <p className="fbl-empty">
          <span>Boot audio to see the signal.</span>
        </p>
      )}
    </div>
  );
}
