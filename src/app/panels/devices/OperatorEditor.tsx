// The Operator panel: an algorithm you pick from pictures, and one operator
// at a time in detail.
//
// The device declares thirty-eight params. As an SS5 knob grid that is ten
// rows of four, in which the four `bLevel`-shaped knobs sit nowhere near
// each other and nothing on screen says which operator feeds which. The
// panel's job is to put the two facts back that a flat list destroys:
//
//   WHICH OPERATORS EXIST, and how they are wired — the diagram row, where
//   every algorithm is drawn rather than named, because "D→C→B→A" is a
//   description of a picture and the picture is smaller.
//
//   WHAT ONE OPERATOR IS DOING — its ratio, its level, and its envelope
//   drawn as a shape, because an envelope is four numbers that only mean
//   something together.
//
// Everything still goes through the SS4 handles: the knobs here are the same
// `Knob` the default panel would have made, so an Operator param automates,
// undoes and saves exactly like every other param. The editor adds pictures,
// not a second way to write values (SS15: React owns chrome only).

import { useEffect, useRef, useState } from "react";
import {
  ALGORITHMS,
  OPERATOR_COUNT,
  OPERATOR_NAMES,
  OUT,
  algorithmAt,
  diagramLayout,
  operatorParamIds,
} from "../../../devices/core";
import { deviceParamId } from "../../../params";
import type { ChannelId, DeviceInstanceId, ParamHandle, ParamId, ProjectSnapshot } from "../../../types";
import { EnumSelect, Knob, ToggleLED } from "../../../ui/controls";
import { INK, SIGNAL, TEXT, alpha } from "../../../ui/theme";
import type { AppProjectEngine } from "../../engine";

// Diagram geometry. Every icon is drawn on the SAME grid — four slots wide
// and four rows tall, whatever the algorithm actually uses — so the eleven
// pictures are one size, line up as a grid, and can be compared at a glance.
// Sizing each icon to its own contents instead made the deep stacks twice the
// height of the flat ones and spilled them over their neighbours.
const BOX_W = 9;
const BOX_H = 7;
const GAP_X = 3;
const GAP_Y = 4;
const GRID_COLS = OPERATOR_COUNT;
const GRID_ROWS = OPERATOR_COUNT;
const DIAGRAM_W = GRID_COLS * BOX_W + (GRID_COLS - 1) * GAP_X;
const DIAGRAM_H = GRID_ROWS * BOX_H + (GRID_ROWS - 1) * GAP_Y + 3;

/** How long the envelope display pretends a note is held, in seconds. The
 *  shape is what matters, not the clock: a fixed window keeps every operator's
 *  envelope comparable at a glance, which a self-scaling one would not. */
const ENV_WINDOW_S = 3;
const ENV_W = 296;
const ENV_H = 54;

export interface OperatorEditorProps {
  doc: ProjectSnapshot;
  engine: AppProjectEngine | null;
  channelId: ChannelId;
  deviceId: DeviceInstanceId;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
}

/** Control testids carry the FULL param path, the same convention the
 *  default panel uses. */
function testIdOf(handle: ParamHandle): string {
  return `ctl-${handle.desc.id}`;
}

/**
 * One algorithm as a picture: boxes for operators, lines for modulation, the
 * carriers on the bottom row above a baseline that stands for the output.
 *
 * Shared by the picker and by nothing else — but written as its own
 * component because it is drawn eleven times per render and the layout math
 * belongs next to the SVG that consumes it.
 */
function AlgorithmDiagram({
  index,
  active,
}: {
  index: number;
  active: boolean;
}) {
  const algorithm = ALGORITHMS[index]!;
  const { x, row, width } = diagramLayout(algorithm);
  // Centred in the fixed grid, and pinned to the BOTTOM of it: carriers of
  // every algorithm then sit on the same line, which is what makes a row of
  // icons readable as "how deep does this one stack".
  const offsetX = ((GRID_COLS - width) * (BOX_W + GAP_X)) / 2;
  const px = (op: number): number => offsetX + (x[op] ?? 0) * (BOX_W + GAP_X);
  const py = (op: number): number => (GRID_ROWS - 1 - (row[op] ?? 0)) * (BOX_H + GAP_Y);
  const line = active ? SIGNAL.aqua : INK.lineStrong;
  const ink = active ? SIGNAL.aqua : TEXT.dim;

  return (
    <svg
      width={DIAGRAM_W}
      height={DIAGRAM_H}
      viewBox={`0 0 ${String(DIAGRAM_W)} ${String(DIAGRAM_H)}`}
      aria-hidden="true"
    >
      {/* modulation edges, drawn first so the boxes sit on top */}
      {Array.from({ length: OPERATOR_COUNT }, (_, op) => {
        const target = algorithm.targets[op] ?? OUT;
        if (target === OUT) return null;
        return (
          <line
            key={op}
            x1={px(op) + BOX_W / 2}
            y1={py(op) + BOX_H}
            x2={px(target) + BOX_W / 2}
            y2={py(target)}
            stroke={line}
            strokeWidth={1}
          />
        );
      })}
      {/* the output line: what "carrier" means, drawn */}
      <line
        x1={offsetX}
        y1={DIAGRAM_H - 1.5}
        x2={offsetX + width * BOX_W + Math.max(0, width - 1) * GAP_X}
        y2={DIAGRAM_H - 1.5}
        stroke={line}
        strokeWidth={1}
        opacity={0.6}
      />
      {Array.from({ length: OPERATOR_COUNT }, (_, op) => (
        <g key={op}>
          <rect
            x={px(op)}
            y={py(op)}
            width={BOX_W}
            height={BOX_H}
            rx={2}
            fill={active ? alpha(SIGNAL.aqua, 0.16) : "transparent"}
            stroke={ink}
            strokeWidth={1}
          />
          <text
            x={px(op) + BOX_W / 2}
            y={py(op) + BOX_H / 2 + 2.2}
            textAnchor="middle"
            fontSize={5.5}
            fill={ink}
          >
            {OPERATOR_NAMES[op]}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * The selected operator's envelope, drawn as the shape it is.
 *
 * Four numbers on four knobs are not an envelope until you can see them at
 * once — and on a MODULATOR this shape is the timbre rather than the
 * loudness, which is the single hardest thing about FM to explain in words
 * and the easiest to show. Sustain is drawn as a level held to the end of the
 * window, with the release falling from it.
 */
function EnvelopeShape({
  attackMs,
  decayMs,
  sustainPct,
  releaseMs,
  carrier,
}: {
  attackMs: number;
  decayMs: number;
  sustainPct: number;
  releaseMs: number;
  carrier: boolean;
}) {
  const pad = 3;
  const w = ENV_W - pad * 2;
  const h = ENV_H - pad * 2;
  const xOf = (seconds: number): number => pad + Math.min(1, seconds / ENV_WINDOW_S) * w;
  const yOf = (level: number): number => pad + (1 - level) * h;

  const a = attackMs / 1000;
  // The decay knob is a time CONSTANT (`setTargetAtTime`), so the audible
  // fall is a few of them — drawing one would show a shape the ear does not
  // hear. Three is the usual "near enough settled".
  const d = (decayMs / 1000) * 1.6;
  const sustain = Math.max(0, Math.min(1, sustainPct / 100));
  const holdEnd = Math.max(a + d, ENV_WINDOW_S * 0.62);
  const r = releaseMs / 1000;

  const points = [
    `${String(xOf(0))},${String(yOf(0))}`,
    `${String(xOf(a))},${String(yOf(1))}`,
    `${String(xOf(a + d))},${String(yOf(sustain))}`,
    `${String(xOf(holdEnd))},${String(yOf(sustain))}`,
    `${String(xOf(holdEnd + r))},${String(yOf(0))}`,
  ].join(" ");
  // Amber for a modulator: on that operator this shape is BRIGHTNESS, not
  // loudness, and the panel should not pretend the two are the same reading.
  const stroke = carrier ? SIGNAL.aqua : SIGNAL.amber;

  return (
    <svg
      className="fbl-op-envelope"
      width={ENV_W}
      height={ENV_H}
      viewBox={`0 0 ${String(ENV_W)} ${String(ENV_H)}`}
      data-testid="operator-envelope"
      aria-hidden="true"
    >
      <rect x={0} y={0} width={ENV_W} height={ENV_H} rx={3} fill="#05070b" stroke={INK.line} />
      {/* where the key comes up */}
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
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 3px ${alpha(stroke, 0.5)})` }}
      />
    </svg>
  );
}

export function OperatorEditor({
  doc,
  engine,
  channelId,
  deviceId,
  onShowAutomation,
}: OperatorEditorProps) {
  const [selected, setSelected] = useState(0);
  const [, force] = useState(0);
  const forceRef = useRef(force);
  forceRef.current = force;
  const ids = operatorParamIds(selected);

  // Handles are registered ASYNCHRONOUSLY, after the mount that made the
  // device (SS7) — so the subscriptions below have to be re-taken when the
  // registry changes, or a freshly added Operator draws its defaults forever.
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => {
    if (engine === null) return;
    return engine.params.onRegistryChange(() => setRegistryTick((n) => n + 1));
  }, [engine]);

  const handle = (localId: string): ParamHandle | undefined =>
    engine?.params.get(deviceParamId(channelId, deviceId, localId));

  /** A param's value whether or not audio is booted: the live handle if the
   *  device is mounted, the document otherwise. The diagrams and the envelope
   *  have to draw before boot, like the EQ's curve. */
  const valueOf = (localId: string): number => {
    const id = deviceParamId(channelId, deviceId, localId);
    const live = engine?.params.get(id);
    if (live !== undefined) return live.live();
    return doc.paramValues[id] ?? 0;
  };

  // The pictures are derived from param values, and a param moving does not
  // re-render this component on its own — the handle notifies subscribers,
  // and only the `Knob`s subscribe, each repainting itself alone.
  //
  // So the editor subscribes to exactly the params it DRAWS: the algorithm,
  // every operator's on/off (the tabs), and the selected operator's ratio and
  // envelope. Twelve subscriptions rather than thirty-eight, and no rAF —
  // eleven SVG diagrams re-rendered sixty times a second to catch a knob that
  // moves once a minute is a lot of layout for nothing.
  const drawnParams = [
    "algorithm",
    ...Array.from({ length: OPERATOR_COUNT }, (_, op) => operatorParamIds(op).on),
    ids.coarse,
    ids.fine,
    ids.attack,
    ids.decay,
    ids.sustain,
    ids.release,
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

  const automation = (localId: string): (() => void) | undefined =>
    onShowAutomation === undefined
      ? undefined
      : () => onShowAutomation(deviceParamId(channelId, deviceId, localId));

  const algorithmIndex = Math.round(valueOf("algorithm"));
  const algorithm = algorithmAt(algorithmIndex);
  const algorithmHandle = handle("algorithm");
  const gainHandle = handle("gain");

  const isCarrier = (algorithm.targets[selected] ?? OUT) === OUT;
  const on = valueOf(ids.on) >= 0.5;
  const ratio = valueOf(ids.coarse) + valueOf(ids.fine) / 100;

  /** Knob or nothing — a handle only exists once the device is mounted. */
  const knob = (localId: string, label?: string) => {
    const h = handle(localId);
    if (h === undefined) return <span className="fbl-param-pending">{localId}</span>;
    return (
      <Knob
        handle={h}
        testId={testIdOf(h)}
        label={label}
        onShowAutomation={automation(localId)}
      />
    );
  };

  return (
    <div className="fbl-operator" data-testid={`operator-${deviceId}`}>
      {/* --- the algorithm, as eleven pictures ------------------------- */}
      <div className="fbl-op-algorithms" data-testid="operator-algorithms" role="radiogroup" aria-label="Algorithm">
        {ALGORITHMS.map((entry, i) => (
          <button
            key={entry.label}
            type="button"
            role="radio"
            aria-checked={i === algorithmIndex}
            aria-label={entry.label}
            title={entry.label}
            className="fbl-op-algorithm"
            data-testid={`operator-algorithm-${deviceId}-${String(i + 1)}`}
            onClick={() => {
              // The picker IS the gesture, so it commits once — same contract
              // the segmented enum control keeps.
              if (algorithmHandle === undefined) return;
              algorithmHandle.setLive(i, "user");
              algorithmHandle.commit();
            }}
          >
            <AlgorithmDiagram index={i} active={i === algorithmIndex} />
          </button>
        ))}
      </div>

      {/* --- which operator you are editing ---------------------------- */}
      <div className="fbl-op-tabs" data-testid="operator-tabs">
        {Array.from({ length: OPERATOR_COUNT }, (_, op) => {
          const opIds = operatorParamIds(op);
          const opOn = valueOf(opIds.on) >= 0.5;
          const carrier = (algorithm.targets[op] ?? OUT) === OUT;
          return (
            <button
              key={op}
              type="button"
              className="fbl-op-tab"
              aria-pressed={op === selected}
              data-on={opOn}
              data-carrier={carrier}
              data-testid={`operator-tab-${deviceId}-${OPERATOR_NAMES[op] ?? ""}`}
              title={`${OPERATOR_NAMES[op] ?? ""} — ${carrier ? "carrier" : `modulates ${OPERATOR_NAMES[algorithm.targets[op] ?? 0] ?? ""}`}`}
              onClick={() => setSelected(op)}
            >
              <span className="fbl-op-tab-name">{OPERATOR_NAMES[op]}</span>
              <span className="fbl-op-tab-role">{carrier ? "out" : `→${OPERATOR_NAMES[algorithm.targets[op] ?? 0] ?? ""}`}</span>
            </button>
          );
        })}
      </div>

      {/* --- the selected operator ------------------------------------- */}
      <div className="fbl-op-detail" data-off={!on}>
        {/* What this operator IS: on or off, its shape, and the one number
            its two integer knobs add up to. */}
        <div className="fbl-op-row fbl-op-row--identity">
          {(() => {
            const h = handle(ids.on);
            return h === undefined ? null : (
              <span className="fbl-toggle">
                <ToggleLED handle={h} testId={testIdOf(h)} label={`${OPERATOR_NAMES[selected] ?? ""} On`} />
                <span className="fbl-control-label">On</span>
              </span>
            );
          })()}
          {(() => {
            const h = handle(ids.wave);
            return h === undefined ? null : <EnumSelect handle={h} testId={testIdOf(h)} />;
          })()}
          {/* The two integers say one thing, so the panel says it: a ratio.
              Reading `coarse 3 / fine 50` off two knobs and multiplying is
              arithmetic the instrument should not be asking for. */}
          <span className="fbl-op-ratio" data-testid="operator-ratio">
            <span className="fbl-op-ratio-value">{ratio.toFixed(2)}</span>
            <span className="fbl-control-label">Ratio</span>
          </span>
        </div>

        <div className="fbl-op-row">
          <span className="fbl-param-row-label">Osc</span>
          {knob(ids.coarse, "Coarse")}
          {knob(ids.fine, "Fine")}
          {knob(ids.level, "Level")}
        </div>

        <div className="fbl-op-row">
          <span className="fbl-param-row-label">Env</span>
          {knob(ids.attack, "Attack")}
          {knob(ids.decay, "Decay")}
          {knob(ids.sustain, "Sustain")}
          {knob(ids.release, "Release")}
        </div>

        <EnvelopeShape
          attackMs={valueOf(ids.attack)}
          decayMs={valueOf(ids.decay)}
          sustainPct={valueOf(ids.sustain)}
          releaseMs={valueOf(ids.release)}
          carrier={isCarrier}
        />
      </div>

      {/* The one param that belongs to the device rather than to an
          operator. A custom editor replaces the SS5 rows entirely, so
          anything it does not draw is a param nobody can reach. */}
      <div className="fbl-op-row">
        {gainHandle !== undefined && (
          <Knob
            handle={gainHandle}
            testId={testIdOf(gainHandle)}
            onShowAutomation={automation("gain")}
          />
        )}
        <span className="fbl-op-legend">
          {isCarrier
            ? `${OPERATOR_NAMES[selected] ?? ""} is a carrier — its envelope is loudness`
            : `${OPERATOR_NAMES[selected] ?? ""} modulates ${OPERATOR_NAMES[algorithm.targets[selected] ?? 0] ?? ""} — its envelope is brightness`}
        </span>
      </div>
    </div>
  );
}
