// The EQ Eight panel: a curve over the live spectrum, with eight handles you
// drag.
//
// This is the first `DeviceDefinition.editor` — a device whose controls are a
// PICTURE rather than a row of knobs. The seam is deliberately narrow: the
// definition names an editor, the shell owns the component, and the device
// layer still knows nothing about React (SS7/SS15).
//
// Two sources feed the picture, and they are different on purpose:
//   - the CURVE comes from the document's numbers through
//     `totalResponseDb` — a pure function, so it draws before audio is
//     booted, for a channel whose devices are not mounted, and it cannot
//     drift from the knob the user is turning;
//   - the SPECTRUM comes from an `AnalyserNode` on the device's own output,
//     so what is behind the curve is what the EQ is actually putting out.
//
// Every edit goes through the SS4 handle (`setLive` during the drag, one
// `commit` at the end), exactly as a knob does — so an EQ drag automates,
// undoes and saves like any other param change, and the numeric controls
// below the canvas are the same values by another route.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  BAND_GAIN_MAX_DB,
  BAND_GAIN_MIN_DB,
  BAND_FREQ_MAX_HZ,
  BAND_FREQ_MIN_HZ,
  BAND_Q_MAX,
  BAND_Q_MIN,
  EQ8_BAND_COUNT,
  bandParamIds,
} from "../../../devices/core/eq8";
import {
  GAIN_TYPES,
  Q_TYPES,
  bandTypeFromIndex,
  totalResponseDb,
  type BandSettings,
} from "../../../devices/core/eq8/response";
import { deviceParamId } from "../../../params";
import type { ChannelId, DeviceInstanceId, ParamHandle, ParamId, ProjectSnapshot } from "../../../types";
import { EnumSelect, Knob, ToggleLED } from "../../../ui/controls";
import { CANVAS_FONT, INK, SIGNAL, TEXT, alpha } from "../../../ui/theme";
import type { AppProjectEngine } from "../../engine";
import { MAX_HZ, MIN_HZ, logPosition, hzAtPosition, spectrumBands } from "../scope/analysis";

/** The curve's vertical range. Wider than a band's own ±18 dB, because eight
 *  of them in series add up and a curve clipped at its own limit reads as a
 *  flat top rather than as "you have gone too far". */
const VIEW_DB = 24;
/** Samples across the curve. One per ~2 px at a typical panel width. */
const CURVE_POINTS = 220;
/** Spectrum bars behind the curve. */
const BAND_COUNT = 72;
/** Labelled vertical grid lines, in Hz. */
const HZ_GRID = [100, 1000, 10000] as const;
/** Horizontal grid, in dB. */
const DB_GRID = [-18, -12, -6, 6, 12, 18] as const;
/** How near the pointer has to be to a handle to grab it, in CSS pixels. */
const GRAB_RADIUS_PX = 22;
/** Q change per wheel notch, as a multiplier. */
const Q_WHEEL_STEP = 1.12;

export interface Eq8EditorProps {
  doc: ProjectSnapshot;
  engine: AppProjectEngine | null;
  channelId: ChannelId;
  deviceId: DeviceInstanceId;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
}

function hzLabel(hz: number): string {
  return hz >= 1000 ? `${String(hz / 1000)}k` : String(hz);
}

/** Where a dB value sits vertically, 0 at the top. */
function dbToY(db: number, height: number): number {
  return ((VIEW_DB - db) / (2 * VIEW_DB)) * height;
}

function yToDb(y: number, height: number): number {
  return VIEW_DB - (y / height) * 2 * VIEW_DB;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** The control-kit testid convention: `ctl-` plus the FULL param path, which
 *  is what a registered handle's `desc.id` already is (`qualifyDescriptor`).
 *  Same as the default panel's, so there is one convention and not two. */
function testIdOf(handle: ParamHandle): string {
  return `ctl-${handle.desc.id}`;
}

export function Eq8Editor({ doc, engine, channelId, deviceId, onShowAutomation }: Eq8EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selected, setSelected] = useState(1);
  // Repaints are driven by rAF while mounted (the spectrum changes every
  // frame), so nothing here needs to re-render React on a param change —
  // except the band controls below, which do.
  const [, force] = useState(0);

  /** A band's live value, with the document and then the descriptor behind it:
   *  the panel draws before audio is booted, when there are no handles yet. */
  const valueOf = (localId: string): number => {
    const id = deviceParamId(channelId, deviceId, localId);
    const handle = engine?.params.get(id);
    if (handle !== undefined) return handle.live();
    const stored = doc.paramValues[id];
    if (stored !== undefined) return stored;
    return 0;
  };

  const handleOf = (localId: string): ParamHandle | undefined =>
    engine?.params.get(deviceParamId(channelId, deviceId, localId));

  const bandsRef = useRef<BandSettings[]>([]);
  const readBands = (): BandSettings[] => {
    const out: BandSettings[] = [];
    for (let i = 0; i < EQ8_BAND_COUNT; i++) {
      const ids = bandParamIds(i);
      out.push({
        type: bandTypeFromIndex(valueOf(ids.type)),
        freqHz: valueOf(ids.freq),
        gainDb: valueOf(ids.gain),
        q: valueOf(ids.q),
        enabled: valueOf(ids.on) >= 0.5,
      });
    }
    return out;
  };
  bandsRef.current = readBands();

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // --- paint ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    let spectrum: Float32Array<ArrayBuffer> = new Float32Array(BAND_COUNT);
    // Resolved per frame until it appears, NOT once when the effect runs: a
    // device is mounted asynchronously (the reconciler awaits `prepare`), so
    // at the moment this panel first renders the device the user just added
    // is not in the graph yet. Asking once and caching the `null` left the
    // spectrum permanently blank behind a perfectly good curve.
    let analyser: AnalyserNode | null = null;
    let freqData: Uint8Array<ArrayBuffer> | null = null;
    // Before audio is booted there is no analyser and no context; the curve
    // still has to be drawn, and 48 kHz is the right guess for its shape.
    let sampleRate = 48000;

    const resolveAnalyser = (): void => {
      if (analyser !== null) return;
      const found = engine?.deviceAnalyser(deviceId) ?? null;
      if (found === null) return;
      analyser = found;
      freqData = new Uint8Array(found.frequencyBinCount);
      sampleRate = found.context.sampleRate;
    };

    const draw = (): void => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || canvas.clientWidth;
      const h = rect.height || canvas.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dw = Math.max(1, Math.round(w * dpr));
      const dh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== dw) canvas.width = dw;
      if (canvas.height !== dh) canvas.height = dh;
      const c = canvas.getContext("2d");
      if (c === null) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      resolveAnalyser();

      c.fillStyle = INK.well;
      c.fillRect(0, 0, w, h);

      // --- spectrum, behind everything ------------------------------------
      if (analyser !== null && freqData !== null) {
        analyser.getByteFrequencyData(freqData);
        spectrum = spectrumBands(freqData, sampleRate, analyser.fftSize, BAND_COUNT, spectrum);
        c.fillStyle = alpha(SIGNAL.aqua, 0.16);
        const barWidth = w / BAND_COUNT;
        for (let i = 0; i < BAND_COUNT; i++) {
          const value = spectrum[i] ?? 0;
          if (value <= 0) continue;
          const barHeight = value * h;
          c.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth - 1), barHeight);
        }
      }

      // --- grid -------------------------------------------------------------
      c.font = CANVAS_FONT.micro;
      c.textBaseline = "bottom";
      c.textAlign = "center";
      for (const hz of HZ_GRID) {
        const x = Math.round(logPosition(hz, MIN_HZ, MAX_HZ) * w) + 0.5;
        c.strokeStyle = INK.line;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
        c.fillStyle = TEXT.faint;
        c.fillText(hzLabel(hz), x, h - 2);
      }
      c.textAlign = "right";
      c.textBaseline = "middle";
      for (const db of DB_GRID) {
        const y = Math.round(dbToY(db, h)) + 0.5;
        c.strokeStyle = INK.line;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
        // Only the ±12 lines are labelled: an axis labelled at every line is
        // a wall of digits over the thing you are trying to look at.
        if (Math.abs(db) === 12) {
          c.fillStyle = TEXT.faint;
          c.fillText(`${db > 0 ? "+" : ""}${String(db)}`, w - 3, y);
        }
      }
      // The 0 dB line is the one the eye measures everything against.
      const zeroY = Math.round(dbToY(0, h)) + 0.5;
      c.strokeStyle = INK.lineStrong;
      c.beginPath();
      c.moveTo(0, zeroY);
      c.lineTo(w, zeroY);
      c.stroke();

      // --- the curve --------------------------------------------------------
      const bands = bandsRef.current;
      c.beginPath();
      for (let i = 0; i <= CURVE_POINTS; i++) {
        const hz = hzAtPosition(i / CURVE_POINTS, MIN_HZ, MAX_HZ);
        const y = dbToY(clamp(totalResponseDb(bands, hz, sampleRate), -VIEW_DB, VIEW_DB), h);
        const x = (i / CURVE_POINTS) * w;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.strokeStyle = SIGNAL.aqua;
      c.lineWidth = 2;
      c.stroke();
      // A wash under the curve, so a boost and a cut read apart at a glance.
      c.lineTo(w, zeroY);
      c.lineTo(0, zeroY);
      c.closePath();
      c.fillStyle = alpha(SIGNAL.aqua, 0.1);
      c.fill();
      c.lineWidth = 1;

      // --- handles ----------------------------------------------------------
      for (let i = 0; i < bands.length; i++) {
        const band = bands[i]!;
        const x = logPosition(band.freqHz, MIN_HZ, MAX_HZ) * w;
        const showsGain = GAIN_TYPES.has(band.type);
        const y = dbToY(showsGain ? clamp(band.gainDb, -VIEW_DB, VIEW_DB) : 0, h);
        const isSelected = i === selectedRef.current;
        c.beginPath();
        c.arc(x, y, isSelected ? 8 : 6, 0, Math.PI * 2);
        c.fillStyle = band.enabled
          ? isSelected
            ? SIGNAL.amber
            : alpha(SIGNAL.aqua, 0.85)
          : alpha(TEXT.faint, 0.6);
        c.fill();
        c.strokeStyle = INK.well;
        c.lineWidth = 2;
        c.stroke();
        c.lineWidth = 1;
        c.fillStyle = band.enabled ? INK.well : TEXT.dim;
        c.font = CANVAS_FONT.micro;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(String(i + 1), x, y + 0.5);
      }
    };

    let raf = requestAnimationFrame(function loop() {
      draw();
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [engine, deviceId]);

  // --- dragging -------------------------------------------------------------
  const dragRef = useRef<{ band: number; pointerId: number } | null>(null);

  /** Nearest band handle to a point, and how far away it is in CSS px. */
  const nearest = (x: number, y: number, w: number, h: number): { index: number; distance: number } => {
    let best = 0;
    let bestDistance = Infinity;
    const bands = bandsRef.current;
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!;
      const bx = logPosition(band.freqHz, MIN_HZ, MAX_HZ) * w;
      const by = dbToY(GAIN_TYPES.has(band.type) ? clamp(band.gainDb, -VIEW_DB, VIEW_DB) : 0, h);
      const distance = Math.hypot(bx - x, by - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return { index: best, distance: bestDistance };
  };

  const writeDrag = (index: number, x: number, y: number, w: number, h: number): void => {
    const ids = bandParamIds(index);
    const band = bandsRef.current[index];
    if (band === undefined) return;
    const freq = handleOf(ids.freq);
    freq?.setLive(clamp(hzAtPosition(x / w, MIN_HZ, MAX_HZ), BAND_FREQ_MIN_HZ, BAND_FREQ_MAX_HZ), "user");
    // A cut or a notch has no gain to set — dragging one vertically would
    // silently write a number nothing reads.
    if (GAIN_TYPES.has(band.type)) {
      handleOf(ids.gain)?.setLive(
        clamp(yToDb(y, h), BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB),
        "user",
      );
    }
    bandsRef.current = readBands();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = nearest(x, y, rect.width, rect.height);
    setSelected(hit.index);
    if (hit.distance > GRAB_RADIUS_PX) return; // a click near nothing only selects
    // Alt-click toggles the band, which is the fastest way to A/B one.
    if (event.altKey) {
      const on = handleOf(bandParamIds(hit.index).on);
      if (on !== undefined) {
        on.setLive(on.live() >= 0.5 ? 0 : 1, "user");
        on.commit();
        force((n) => n + 1);
      }
      return;
    }
    dragRef.current = { band: hit.index, pointerId: event.pointerId };
    canvas.setPointerCapture(event.pointerId);
    writeDrag(hit.index, x, y, rect.width, rect.height);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (drag === null || canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    writeDrag(drag.band, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    canvasRef.current?.releasePointerCapture(event.pointerId);
    // One commit per param touched (SS4: a gesture ends in exactly one
    // command per param). Freq and gain are two params, so a diagonal drag is
    // two undo entries — the same arithmetic as turning two knobs, which is
    // what it is.
    const ids = bandParamIds(drag.band);
    handleOf(ids.freq)?.commit();
    if (GAIN_TYPES.has(bandsRef.current[drag.band]?.type ?? "bell")) {
      handleOf(ids.gain)?.commit();
    }
    force((n) => n + 1);
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>): void => {
    const band = bandsRef.current[selected];
    if (band === undefined || !Q_TYPES.has(band.type)) return;
    const q = handleOf(bandParamIds(selected).q);
    if (q === undefined) return;
    const factor = event.deltaY < 0 ? Q_WHEEL_STEP : 1 / Q_WHEEL_STEP;
    q.setLive(clamp(q.live() * factor, BAND_Q_MIN, BAND_Q_MAX), "user");
    q.commit();
  };

  const ids = bandParamIds(selected);
  const band = bandsRef.current[selected];
  const onHandle = handleOf(ids.on);
  const typeHandle = handleOf(ids.type);
  const freqHandle = handleOf(ids.freq);
  const gainHandle = handleOf(ids.gain);
  const qHandle = handleOf(ids.q);
  const outputHandle = handleOf("output");
  const automation = (localId: string): (() => void) | undefined =>
    onShowAutomation === undefined
      ? undefined
      : () => onShowAutomation(deviceParamId(channelId, deviceId, localId));

  return (
    <div className="fbl-eq8" data-testid={`eq8-${deviceId}`}>
      <canvas
        ref={canvasRef}
        className="fbl-eq8-canvas"
        data-testid={`eq8-canvas-${deviceId}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      />
      <div className="fbl-eq8-bands">
        {Array.from({ length: EQ8_BAND_COUNT }, (_, i) => {
          const settings = bandsRef.current[i];
          return (
            <button
              key={i}
              type="button"
              className="fbl-eq8-band"
              data-testid={`eq8-band-${deviceId}-${String(i + 1)}`}
              aria-pressed={i === selected}
              data-on={settings?.enabled ?? false}
              title={`Band ${String(i + 1)}`}
              onClick={() => setSelected(i)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      {band !== undefined && (
        <div className="fbl-eq8-controls">
          {onHandle !== undefined && (
            <span className="fbl-toggle">
              <ToggleLED handle={onHandle} testId={testIdOf(onHandle)} />
              <span className="fbl-control-label">On</span>
            </span>
          )}
          {typeHandle !== undefined && (
            <EnumSelect handle={typeHandle} testId={testIdOf(typeHandle)} />
          )}
          {freqHandle !== undefined && (
            <Knob
              handle={freqHandle}
              testId={testIdOf(freqHandle)}
              onShowAutomation={automation(ids.freq)}
            />
          )}
          {gainHandle !== undefined && GAIN_TYPES.has(band.type) && (
            <Knob
              handle={gainHandle}
              testId={testIdOf(gainHandle)}
              onShowAutomation={automation(ids.gain)}
            />
          )}
          {qHandle !== undefined && Q_TYPES.has(band.type) && (
            <Knob
              handle={qHandle}
              testId={testIdOf(qHandle)}
              onShowAutomation={automation(ids.q)}
            />
          )}
          {/* The one param that belongs to the device rather than to a band.
              A custom editor replaces the SS5 panel entirely, so anything it
              does not draw is a param the user cannot reach. */}
          {outputHandle !== undefined && (
            <Knob
              handle={outputHandle}
              testId={testIdOf(outputHandle)}
              onShowAutomation={automation("output")}
            />
          )}
        </div>
      )}
    </div>
  );
}
