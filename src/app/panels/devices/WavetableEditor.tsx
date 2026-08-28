// The Wavetable panel: the table you are playing, drawn; the filter you have
// built, drawn; and the modulation matrix as an actual matrix.
//
// The device declares NINETY params. As an SS5 knob grid that is a
// twenty-three-row wall in which `modLfo1Cut1` sits between two knobs it has
// nothing to do with, the two oscillators' identical seven knobs are
// impossible to tell apart, and the one thing you most want to know — what
// this table sounds like as Position sweeps — is not on screen at all. The
// panel's job is to put back the four facts a flat list destroys:
//
//   WHAT THE TABLE IS. Sixteen frames stacked, with the one you are reading
//   drawn in front. Position stops being a percentage and becomes a place.
//
//   WHAT THE FILTERS DO. Their magnitude response, from the same maths the
//   DSP runs (`filterMagnitude`), so the picture cannot drift from the sound.
//
//   WHAT IS CONNECTED TO WHAT. A grid of sources against destinations, which
//   is what a modulation matrix IS — forty-two knobs in a list is the same
//   information with the shape taken out.
//
//   WHICH OF THE THREE ENVELOPES YOU ARE EDITING, since they are otherwise
//   twelve identically-named knobs.
//
// Five views rather than one long card, because the Devices pane is a strip
// and 900 px of instrument in it would be a scrollbar with a synth behind it.
// Everything still goes through the SS4 handles: every control here is the
// same `Knob` the default panel would have made, so a Wavetable param
// automates, undoes and saves like any other (SS15: React owns chrome only).

import { useEffect, useRef, useState } from "react";
import {
  ENV_NAMES,
  FILTER_ROUTINGS,
  FRAME_COUNT,
  MOD_PARAM_IDS,
  MOD_SOURCES,
  MOD_TARGETS,
  OSC_NAMES,
  buildWavetable,
  envParamIds,
  filterMagnitude,
  filterParamIds,
  framesForDisplay,
  lfoParamIds,
  oscParamIds,
  readFrame,
  sampleFrames,
  wavetableAt,
} from "../../../devices/core";
import { Lfo } from "../../../devices/core/wavetable/lfo";
import { deviceParamId } from "../../../params";
import { automatedParamIds } from "../../../state";
import type { ChannelId, DeviceInstanceId, ParamHandle, ParamId, ProjectSnapshot } from "../../../types";
import { EnumSelect, Knob, ToggleLED } from "../../../ui/controls";
import { INK, SIGNAL, TEXT, alpha } from "../../../ui/theme";
import type { AppProjectEngine } from "../../engine";

/** The table display: a stack of frames in false perspective. */
const DISPLAY_W = 318;
const DISPLAY_H = 116;
const WAVE_W = 206;
const WAVE_H = 30;
const STACK_DX = 6;
const STACK_DY = 4.6;
const WAVE_POINTS = 80;

const CURVE_W = 318;
const CURVE_H = 92;
const CURVE_MIN_HZ = 20;
const CURVE_MAX_HZ = 20000;
const CURVE_TOP_DB = 24;
const CURVE_BOTTOM_DB = -36;
/**
 * The rate the response curve is drawn at.
 *
 * A filter's shape near Nyquist depends on the sample rate, and the panel has
 * to draw before the audio context exists (a project opens with its devices
 * visible and no output yet). 48 kHz is the rate this draws at; at 44.1 the
 * real curve bends a hair earlier above ~15 kHz, which is nothing you would
 * set a cutoff by.
 */
const CURVE_SAMPLE_RATE = 48000;

const ENV_W = 300;
const ENV_H = 58;
const LFO_W = 74;
const LFO_H = 26;

const VIEWS = [
  { id: "osc", label: "Osc" },
  { id: "filter", label: "Filter" },
  { id: "env", label: "Env" },
  { id: "lfo", label: "LFO" },
  { id: "matrix", label: "Matrix" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

export interface WavetableEditorProps {
  doc: ProjectSnapshot;
  engine: AppProjectEngine | null;
  channelId: ChannelId;
  deviceId: DeviceInstanceId;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
}

/** Control testids carry the FULL param path, as the default panel's do. */
function testIdOf(handle: ParamHandle): string {
  return `ctl-${handle.desc.id}`;
}

/**
 * One wavetable, stacked: every frame drawn once, receding up and to the
 * right, with the frame Position is actually reading drawn in front of them.
 *
 * The stack is the point. A single waveform tells you what you are hearing
 * now; the stack tells you what is on either side of it, which is the only
 * way to know what turning Position — or pointing an envelope at it — is
 * going to do.
 */
function WavetableDisplay({ tableIndex, position }: { tableIndex: number; position: number }) {
  const data = buildWavetable(tableIndex);
  const frames = framesForDisplay(data);
  const pad = 6;
  const baseY = DISPLAY_H - pad - WAVE_H / 2;
  const pointsOf = (read: (phase: number) => number, frame: number): string => {
    const ox = pad + frame * STACK_DX;
    const oy = baseY - frame * STACK_DY;
    const out: string[] = [];
    for (let i = 0; i <= WAVE_POINTS; i++) {
      const phase = i / WAVE_POINTS;
      const x = ox + phase * WAVE_W;
      const y = oy - read(phase) * (WAVE_H / 2);
      out.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return out.join(" ");
  };

  const clamped = position < 0 ? 0 : position > 1 ? 1 : position;
  const live = clamped * (FRAME_COUNT - 1);

  return (
    <svg
      className="fbl-wt-display"
      width={DISPLAY_W}
      height={DISPLAY_H}
      viewBox={`0 0 ${String(DISPLAY_W)} ${String(DISPLAY_H)}`}
      data-testid="wavetable-display"
      aria-hidden="true"
    >
      <rect x={0} y={0} width={DISPLAY_W} height={DISPLAY_H} rx={3} fill="#05070b" stroke={INK.line} />
      {/* Back to front, so the near frames occlude the far ones. */}
      {Array.from({ length: FRAME_COUNT }, (_unused, i) => FRAME_COUNT - 1 - i).map((frame) => {
        const near = 1 - Math.min(1, Math.abs(frame - live) / 4);
        return (
          <polyline
            key={frame}
            points={pointsOf((phase) => readFrame(frames[frame] ?? new Float32Array(1), phase), frame)}
            fill="none"
            stroke={near > 0 ? alpha(SIGNAL.aqua, 0.1 + near * 0.25) : INK.lineStrong}
            strokeWidth={1}
          />
        );
      })}
      {/* Where Position actually is — between frames, like the oscillator. */}
      <polyline
        points={pointsOf((phase) => sampleFrames(frames, FRAME_COUNT, clamped, phase), live)}
        fill="none"
        stroke={SIGNAL.aqua}
        strokeWidth={1.8}
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 4px ${alpha(SIGNAL.aqua, 0.55)})` }}
      />
    </svg>
  );
}

interface CurveFilter {
  on: boolean;
  type: number;
  cutoff: number;
  res: number;
}

/**
 * The filter section's magnitude response — each filter, and (in Serial,
 * where it is exactly the product of the two) the response of the pair.
 *
 * Parallel and Split get no combined curve on purpose. A parallel sum is a
 * COMPLEX sum, so drawing the two magnitudes added would show a bump where
 * the real filters cancel; and in Split the two curves are not a pair at all,
 * they are one per oscillator.
 */
function FilterCurve({ f1, f2, routing }: { f1: CurveFilter; f2: CurveFilter; routing: number }) {
  const xOf = (hz: number): number =>
    (Math.log(hz / CURVE_MIN_HZ) / Math.log(CURVE_MAX_HZ / CURVE_MIN_HZ)) * CURVE_W;
  const yOf = (db: number): number =>
    ((CURVE_TOP_DB - db) / (CURVE_TOP_DB - CURVE_BOTTOM_DB)) * CURVE_H;
  const steps = 128;
  const hzAt = (i: number): number =>
    CURVE_MIN_HZ * (CURVE_MAX_HZ / CURVE_MIN_HZ) ** (i / steps);

  const pathOf = (magnitude: (hz: number) => number): string => {
    const out: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const hz = hzAt(i);
      const db = 20 * Math.log10(Math.max(1e-4, magnitude(hz)));
      out.push(`${i === 0 ? "M" : "L"} ${xOf(hz).toFixed(1)} ${yOf(db).toFixed(1)}`);
    }
    return out.join(" ");
  };

  const magOf = (f: CurveFilter) => (hz: number) =>
    filterMagnitude(f.type, f.cutoff, f.res / 100, hz, CURVE_SAMPLE_RATE);
  const both = f1.on && f2.on;

  return (
    <svg
      className="fbl-wt-curve"
      width={CURVE_W}
      height={CURVE_H}
      viewBox={`0 0 ${String(CURVE_W)} ${String(CURVE_H)}`}
      data-testid="wavetable-filter-curve"
      aria-hidden="true"
    >
      <rect x={0} y={0} width={CURVE_W} height={CURVE_H} rx={3} fill="#05070b" stroke={INK.line} />
      {[100, 1000, 10000].map((hz) => (
        <line
          key={hz}
          x1={xOf(hz)}
          y1={0}
          x2={xOf(hz)}
          y2={CURVE_H}
          stroke={INK.line}
          strokeWidth={1}
        />
      ))}
      <line x1={0} y1={yOf(0)} x2={CURVE_W} y2={yOf(0)} stroke={INK.lineStrong} strokeWidth={1} />
      {f1.on && (
        <path
          d={pathOf(magOf(f1))}
          fill="none"
          stroke={SIGNAL.aqua}
          strokeWidth={both && routing === 0 ? 1 : 1.7}
          opacity={both && routing === 0 ? 0.45 : 1}
        />
      )}
      {f2.on && (
        <path
          d={pathOf(magOf(f2))}
          fill="none"
          stroke={SIGNAL.amber}
          strokeWidth={both && routing === 0 ? 1 : 1.7}
          opacity={both && routing === 0 ? 0.45 : 1}
        />
      )}
      {both && routing === 0 && (
        <path
          d={pathOf((hz) => magOf(f1)(hz) * magOf(f2)(hz))}
          fill="none"
          stroke={SIGNAL.aqua}
          strokeWidth={1.9}
          strokeLinejoin="round"
          data-testid="wavetable-filter-combined"
          style={{ filter: `drop-shadow(0 0 4px ${alpha(SIGNAL.aqua, 0.45)})` }}
        />
      )}
      {!f1.on && !f2.on && (
        <text x={CURVE_W / 2} y={CURVE_H / 2 + 3} textAnchor="middle" fontSize={9} fill={TEXT.faint}>
          both filters bypassed
        </text>
      )}
    </svg>
  );
}

/**
 * One envelope, drawn as the shape it is — with STRAIGHT segments, because
 * the generator behind it (`AdsrEnvelope`) really does ramp linearly. An
 * exponential picture over a linear envelope would be a nicer drawing of a
 * different synth.
 */
function EnvelopeShape({
  attackMs,
  decayMs,
  sustainPct,
  releaseMs,
  accent,
}: {
  attackMs: number;
  decayMs: number;
  sustainPct: number;
  releaseMs: number;
  accent: string;
}) {
  const pad = 4;
  const w = ENV_W - pad * 2;
  const h = ENV_H - pad * 2;
  const a = attackMs / 1000;
  const d = decayMs / 1000;
  const r = releaseMs / 1000;
  // The window follows the envelope rather than being fixed: these ranges run
  // to twelve seconds, and a fixed window would draw every long envelope as
  // the same vertical line.
  const window = Math.max(0.8, (a + d + r) * 1.4);
  const sustain = Math.max(0, Math.min(1, sustainPct / 100));
  const holdEnd = Math.max(a + d, window - r);
  const xOf = (seconds: number): number => pad + Math.min(1, seconds / window) * w;
  const yOf = (level: number): number => pad + (1 - level) * h;

  const points = [
    `${xOf(0)},${yOf(0)}`,
    `${xOf(a)},${yOf(1)}`,
    `${xOf(a + d)},${yOf(sustain)}`,
    `${xOf(holdEnd)},${yOf(sustain)}`,
    `${xOf(holdEnd + r)},${yOf(0)}`,
  ].join(" ");

  return (
    <svg
      className="fbl-wt-env"
      width={ENV_W}
      height={ENV_H}
      viewBox={`0 0 ${String(ENV_W)} ${String(ENV_H)}`}
      data-testid="wavetable-envelope"
      aria-hidden="true"
    >
      <rect x={0} y={0} width={ENV_W} height={ENV_H} rx={3} fill="#05070b" stroke={INK.line} />
      <line
        x1={xOf(holdEnd)}
        y1={pad}
        x2={xOf(holdEnd)}
        y2={ENV_H - pad}
        stroke={INK.lineStrong}
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <polyline
        points={points}
        fill="none"
        stroke={accent}
        strokeWidth={1.6}
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 3px ${alpha(accent, 0.5)})` }}
      />
      <text x={ENV_W - pad - 2} y={ENV_H - pad - 2} textAnchor="end" fontSize={8} fill={TEXT.faint}>
        {window.toFixed(1)} s
      </text>
    </svg>
  );
}

/** Two cycles of an LFO shape, drawn by the generator that produces it. */
function LfoShape({ shape }: { shape: number }) {
  const steps = 72;
  const lfo = new Lfo(20250828);
  lfo.reset();
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const value = lfo.next(shape, 2 / steps);
    points.push(`${((i / steps) * LFO_W).toFixed(1)},${((1 - (value + 1) / 2) * (LFO_H - 4) + 2).toFixed(1)}`);
  }
  return (
    <svg
      className="fbl-wt-lfo-shape"
      width={LFO_W}
      height={LFO_H}
      viewBox={`0 0 ${String(LFO_W)} ${String(LFO_H)}`}
      aria-hidden="true"
    >
      <rect x={0} y={0} width={LFO_W} height={LFO_H} rx={3} fill="#05070b" stroke={INK.line} />
      <polyline points={points.join(" ")} fill="none" stroke={SIGNAL.blue} strokeWidth={1.4} />
    </svg>
  );
}

export function WavetableEditor({
  doc,
  engine,
  channelId,
  deviceId,
  onShowAutomation,
}: WavetableEditorProps) {
  const [view, setView] = useState<ViewId>("osc");
  const [osc, setOsc] = useState(0);
  const [env, setEnv] = useState(0);
  const [, force] = useState(0);
  const forceRef = useRef(force);
  forceRef.current = force;

  // Handles register ASYNCHRONOUSLY, after the mount that made the device
  // (SS7), so the subscriptions have to be re-taken when the registry
  // changes or a freshly added Wavetable draws its defaults forever.
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => {
    if (engine === null) return;
    return engine.params.onRegistryChange(() => setRegistryTick((n) => n + 1));
  }, [engine]);

  const handle = (localId: string): ParamHandle | undefined =>
    engine?.params.get(deviceParamId(channelId, deviceId, localId));

  /** A param's value whether or not audio is booted — the pictures have to
   *  draw before the first note, like the EQ's curve. */
  const valueOf = (localId: string): number => {
    const id = deviceParamId(channelId, deviceId, localId);
    const live = engine?.params.get(id);
    if (live !== undefined) return live.live();
    return doc.paramValues[id] ?? 0;
  };

  const oscIds = oscParamIds(osc);
  const f1Ids = filterParamIds(0);
  const f2Ids = filterParamIds(1);
  const envIds = envParamIds(env);

  // Subscribe to exactly the params this component DRAWS — a param moving
  // does not re-render the editor on its own (only the `Knob` that owns it
  // repaints). Not all ninety: the display needs two, the curve eight, the
  // envelope four.
  const drawnParams = [
    oscIds.table,
    oscIds.pos,
    "routing",
    f1Ids.on,
    f1Ids.type,
    f1Ids.cutoff,
    f1Ids.res,
    f2Ids.on,
    f2Ids.type,
    f2Ids.cutoff,
    f2Ids.res,
    envIds.attack,
    envIds.decay,
    envIds.sustain,
    envIds.release,
    lfoParamIds(0).shape,
    lfoParamIds(1).shape,
    // Only while the grid is on screen: forty-two more subscriptions is a lot
    // to hold open for a view nobody is looking at, and every cell's own knob
    // repaints itself regardless. What the EDITOR draws from them is which
    // cells are live — the highlight and the number on the line.
    ...(view === "matrix" ? MOD_PARAM_IDS.flat() : []),
  ];
  const drawnKey = drawnParams.join(",");
  useEffect(() => {
    if (engine === null) return;
    const offs = drawnKey
      .split(",")
      .map((localId) => engine.params.get(deviceParamId(channelId, deviceId, localId)))
      .filter((h): h is ParamHandle => h !== undefined)
      .map((h) => h.onChange(() => forceRef.current((n) => (n + 1) % 1_000_000)));
    return () => {
      for (const off of offs) off();
    };
  }, [engine, channelId, deviceId, drawnKey, registryTick]);

  const automated = automatedParamIds(doc);
  const automation = (localId: string): (() => void) | undefined =>
    onShowAutomation === undefined
      ? undefined
      : () => onShowAutomation(deviceParamId(channelId, deviceId, localId));

  /** A knob, or a placeholder — a handle exists only once the device mounts. */
  const knob = (
    localId: string,
    label?: string,
    size?: number,
    labelShowsValue?: boolean,
  ) => {
    const h = handle(localId);
    if (h === undefined) return <span className="fbl-param-pending">{localId}</span>;
    return (
      <Knob
        handle={h}
        size={size}
        testId={testIdOf(h)}
        label={label}
        labelShowsValue={labelShowsValue}
        hasAutomation={automated.has(h.desc.id as ParamId)}
        onShowAutomation={automation(localId)}
      />
    );
  };

  const enumControl = (localId: string) => {
    const h = handle(localId);
    return h === undefined ? (
      <span className="fbl-param-pending">{localId}</span>
    ) : (
      <EnumSelect handle={h} testId={testIdOf(h)} />
    );
  };

  const toggle = (localId: string, label: string) => {
    const h = handle(localId);
    return h === undefined ? null : (
      <span className="fbl-toggle">
        <ToggleLED handle={h} testId={testIdOf(h)} label={label} />
        <span className="fbl-control-label">{label}</span>
      </span>
    );
  };

  const table = wavetableAt(valueOf(oscIds.table));
  const routing = Math.round(valueOf("routing"));

  return (
    <div className="fbl-wavetable" data-testid={`wavetable-${deviceId}`}>
      <WavetableDisplay
        tableIndex={valueOf(oscIds.table)}
        position={valueOf(oscIds.pos) / 100}
      />
      <div className="fbl-wt-caption" data-testid="wavetable-caption">
        <span className="fbl-wt-caption-name">
          {OSC_NAMES[osc]} · {table.label}
        </span>
        <span className="fbl-wt-caption-blurb">{table.blurb}</span>
      </div>

      <div className="fbl-wt-views" role="tablist" aria-label="Wavetable section">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={view === entry.id}
            className="fbl-wt-view"
            data-testid={`wavetable-view-${deviceId}-${entry.id}`}
            onClick={() => setView(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="fbl-wt-body">
        {view === "osc" &&
          [0, 1].map((which) => {
            const ids = oscParamIds(which);
            const on = valueOf(ids.on) >= 0.5;
            return (
              <div key={which} className="fbl-wt-osc" data-off={!on}>
                <div className="fbl-wt-row">
                  {/* Selecting an oscillator is what the display follows —
                      one table on screen at a time, and it is always the one
                      whose knobs are under your hand. */}
                  <button
                    type="button"
                    className="fbl-wt-pick"
                    aria-pressed={osc === which}
                    data-testid={`wavetable-osc-${deviceId}-${String(which)}`}
                    onClick={() => setOsc(which)}
                  >
                    {OSC_NAMES[which]}
                  </button>
                  {toggle(ids.on, "On")}
                  {enumControl(ids.table)}
                </div>
                <div className="fbl-wt-row">
                  {knob(ids.pos, "Position")}
                  {knob(ids.coarse, "Coarse")}
                  {knob(ids.fine, "Fine")}
                  {knob(ids.level, "Level")}
                  {knob(ids.pan, "Pan")}
                </div>
              </div>
            );
          })}

        {view === "filter" && (
          <>
            <FilterCurve
              routing={routing}
              f1={{
                on: valueOf(f1Ids.on) >= 0.5,
                type: valueOf(f1Ids.type),
                cutoff: valueOf(f1Ids.cutoff),
                res: valueOf(f1Ids.res),
              }}
              f2={{
                on: valueOf(f2Ids.on) >= 0.5,
                type: valueOf(f2Ids.type),
                cutoff: valueOf(f2Ids.cutoff),
                res: valueOf(f2Ids.res),
              }}
            />
            <div className="fbl-wt-row">
              <span className="fbl-param-row-label">Route</span>
              {enumControl("routing")}
              <span className="fbl-wt-hint" data-testid="wavetable-routing-hint">
                {routing === 2
                  ? "Osc A → Filter 1, Osc B → Filter 2"
                  : routing === 1
                    ? "both oscillators through both filters, summed"
                    : "Filter 1, then Filter 2"}
              </span>
            </div>
            {[f1Ids, f2Ids].map((ids, index) => (
              <div key={ids.on} className="fbl-wt-filter" data-off={valueOf(ids.on) < 0.5}>
                <div className="fbl-wt-row">
                  <span className="fbl-param-row-label">{`F${String(index + 1)}`}</span>
                  {toggle(ids.on, "On")}
                  {enumControl(ids.type)}
                </div>
                <div className="fbl-wt-row">
                  {knob(ids.cutoff, "Cutoff")}
                  {knob(ids.res, "Res")}
                  {knob(ids.drive, "Drive")}
                  {knob(ids.key, "Key")}
                </div>
              </div>
            ))}
          </>
        )}

        {view === "env" && (
          <>
            <div className="fbl-wt-tabs">
              {ENV_NAMES.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  className="fbl-wt-tab"
                  aria-pressed={env === index}
                  data-testid={`wavetable-env-${deviceId}-${String(index)}`}
                  onClick={() => setEnv(index)}
                >
                  {name}
                </button>
              ))}
            </div>
            <EnvelopeShape
              attackMs={valueOf(envIds.attack)}
              decayMs={valueOf(envIds.decay)}
              sustainPct={valueOf(envIds.sustain)}
              releaseMs={valueOf(envIds.release)}
              accent={env === 0 ? SIGNAL.aqua : SIGNAL.amber}
            />
            <div className="fbl-wt-row">
              {knob(envIds.attack, "Attack")}
              {knob(envIds.decay, "Decay")}
              {knob(envIds.sustain, "Sustain")}
              {knob(envIds.release, "Release")}
            </div>
            <span className="fbl-wt-hint">
              {env === 0
                ? "the amp envelope — this one is the loudness of the note"
                : `${ENV_NAMES[env] ?? ""} does nothing until the matrix points it somewhere`}
            </span>
          </>
        )}

        {view === "lfo" &&
          [0, 1].map((which) => {
            const ids = lfoParamIds(which);
            return (
              <div key={which} className="fbl-wt-row">
                <span className="fbl-param-row-label">{`L${String(which + 1)}`}</span>
                <LfoShape shape={valueOf(ids.shape)} />
                {enumControl(ids.shape)}
                {knob(ids.rate, "Rate")}
                {toggle(ids.retrig, "Retrig")}
              </div>
            );
          })}

        {view === "matrix" && (
          <div className="fbl-wt-matrix" data-testid="wavetable-matrix">
            <div className="fbl-wt-matrix-head">
              <span />
              {MOD_TARGETS.map((target) => (
                <span key={target.id} className="fbl-wt-matrix-col" title={target.label}>
                  {target.short}
                </span>
              ))}
            </div>
            {MOD_SOURCES.map((source, s) => (
              <div key={source.id} className="fbl-wt-matrix-row">
                <span className="fbl-wt-matrix-source" title={`${source.label} — ${source.blurb}`}>
                  {source.short}
                </span>
                {MOD_TARGETS.map((target, t) => {
                  const localId = MOD_PARAM_IDS[s]?.[t] ?? "";
                  const amount = valueOf(localId);
                  return (
                    <span
                      key={target.id}
                      className="fbl-wt-cell"
                      data-active={Math.abs(amount) > 0.5}
                      title={`${source.label} → ${target.label}`}
                    >
                      {/* An empty label, not no label: the line stays as the
                          hover readout, so a cell shows its amount when you
                          point at it and nothing when you do not — which is
                          what keeps forty-two knobs readable as a grid. */}
                      {/* An active cell shows its amount; an idle one shows
                          nothing until you point at it. Forty-two zeroes on
                          screen is the same information as an empty grid,
                          spelled out at forty-two times the noise. */}
                      {knob(localId, "", 24, Math.abs(amount) > 0.5)}
                    </span>
                  );
                })}
              </div>
            ))}
            <span className="fbl-wt-hint">
              rows modulate columns · right-click a cell to automate it
            </span>
          </div>
        )}
      </div>

      {/* The three params that belong to the instrument rather than to any
          one of its parts. A custom editor replaces the SS5 rows entirely,
          so anything it does not draw is a param nobody can reach. */}
      <div className="fbl-wt-row fbl-wt-foot">
        {knob("voices", "Voices")}
        {knob("glide", "Glide")}
        {knob("gain", "Gain")}
        <span className="fbl-wt-hint">{FILTER_ROUTINGS[routing] ?? ""}</span>
      </div>
    </div>
  );
}
