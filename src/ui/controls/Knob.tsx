// SS5 control inventory: Knob — 270° sweep, value arc from min (or from
// center when `bipolar`), accent arc for the live value plus a small ghost
// dot marking `base()` when automation moves the live value away from it
// (the M3 `automated` display; harmless and truthful before M3 too, since
// live == base whenever the param is free), and "overridden = arc pulses
// dim" — the one per-param signal that this control's lane is suspended
// (the transport pill says only that SOMETHING is overridden).

import type { ParamHandle } from "../../types";
import { toNormalized } from "../../params/taper";
import { ARC_ACCENT, ARC_OVERRIDDEN, ParamControl } from "./ParamControl";
import { INK, SIGNAL, TEXT } from "../theme";

/** The unfilled part of the sweep — a scale, not a value, so it stays
 *  neutral; a coloured track competes with the value arc drawn over it. */
const TRACK_COLOR = INK.lineStrong;
const CAP_EDGE = "#0a0d13";
const POINTER_COLOR = TEXT.primary;
/** Where automation WOULD have this param, when a user's hand has taken it
 *  over (SS4 `overridden`). */
const GHOST_COLOR = SIGNAL.amber;

const SWEEP_DEG = 270;
// `polar` measures degrees clockwise from twelve o'clock, so the sweep runs
// 225° -> 495°: minimum at lower-LEFT, twelve o'clock at the midpoint,
// maximum at lower-right, with the dead zone at the bottom where every
// hardware knob puts it. (It used to start at 135°, which put the dead zone
// on the right-hand side and left a centred bipolar knob pointing sideways.)
const START_DEG = 225;

function angleOf(n: number): number {
  return START_DEG + n * SWEEP_DEG;
}

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  if (Math.abs(toDeg - fromDeg) < 1e-4) return "";
  const from = polar(cx, cy, r, fromDeg);
  const to = polar(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg > fromDeg ? 1 : 0;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

export interface KnobProps {
  handle: ParamHandle;
  size?: number | undefined;
  label?: string | undefined;
  /** Show the VALUE on the line instead of the name, without hovering — for
   *  a knob whose name is already obvious from where it sits (a matrix cell
   *  under its own row and column headers) and whose number is not. */
  labelShowsValue?: boolean | undefined;
  testId?: string | undefined;
  onShowAutomation?: (() => void) | undefined;
  hasAutomation?: boolean | undefined;
}

export function Knob({
  handle,
  size = 38,
  label,
  labelShowsValue,
  testId,
  onShowAutomation,
  hasAutomation,
}: KnobProps) {
  const desc = handle.desc;
  const cx = size / 2;
  const cy = size / 2;
  // The arc rides just inside the edge; the cap fills the rest, so the knob
  // reads as a physical thing with a scale around it rather than as a ring.
  const r = size / 2 - 3.5;
  const capR = r - 4.5;

  return (
    <ParamControl
      handle={handle}
      testId={testId}
      onShowAutomation={onShowAutomation}
      hasAutomation={hasAutomation}
      title={desc.label}
      // The line under the knob is `ParamControl`'s now: it is the
      // click-to-type target, and it swaps to the value on hover, which is
      // the only way a knob ever showed its number without being dragged.
      label={label ?? desc.label}
      labelShowsValue={labelShowsValue}
      labelMaxWidth={size + 22}
    >
      {(value, _dragging, state) => {
        const overridden = state === "overridden";
        const n = toNormalized(desc, value);
        const nBase = toNormalized(desc, handle.base());
        const zero = desc.bipolar === true ? 0.5 : 0;
        const valueArc = arcPath(cx, cy, r, angleOf(Math.min(zero, n)), angleOf(Math.max(zero, n)));
        const pointerFrom = polar(cx, cy, capR * 0.25, angleOf(n));
        const pointerTo = polar(cx, cy, r - 3, angleOf(n));
        const ghost = polar(cx, cy, r + 1.5, angleOf(nBase));
        const showGhost = Math.abs(nBase - n) > 0.01; // automation drift only
        const arcColor = overridden ? ARC_OVERRIDDEN : ARC_ACCENT;
        return (
          <>
            <svg width={size} height={size} aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
              <defs>
                {/* The cap: lit from above, like every knob on every desk. */}
                <linearGradient id={`fbl-cap-${String(size)}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2a3140" />
                  <stop offset="100%" stopColor="#161a23" />
                </linearGradient>
              </defs>
              <path
                d={arcPath(cx, cy, r, START_DEG, START_DEG + SWEEP_DEG)}
                stroke={TRACK_COLOR}
                strokeWidth={3}
                strokeLinecap="round"
                fill="none"
              />
              {valueArc !== "" && (
                <path
                  d={valueArc}
                  stroke={arcColor}
                  strokeWidth={3}
                  strokeLinecap="round"
                  fill="none"
                  data-param-arc={overridden ? "overridden" : "live"}
                  style={overridden ? undefined : { filter: `drop-shadow(0 0 3px ${arcColor}88)` }}
                >
                  {/* SMIL rather than a CSS keyframe: the control kit ships no
                      stylesheet of its own, and a per-instance <style> would
                      be worse. */}
                  {overridden && (
                    <animate
                      attributeName="opacity"
                      values="1;0.35;1"
                      dur="1.4s"
                      repeatCount="indefinite"
                    />
                  )}
                </path>
              )}
              <circle cx={cx} cy={cy} r={capR} fill={`url(#fbl-cap-${String(size)})`} stroke={CAP_EDGE} />
              <line
                x1={pointerFrom.x}
                y1={pointerFrom.y}
                x2={pointerTo.x}
                y2={pointerTo.y}
                stroke={POINTER_COLOR}
                strokeWidth={1.75}
                strokeLinecap="round"
              />
              {showGhost && <circle cx={ghost.x} cy={ghost.y} r={2} fill={GHOST_COLOR} />}
            </svg>
          </>
        );
      }}
    </ParamControl>
  );
}
