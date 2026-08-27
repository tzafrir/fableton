// SS5 control inventory: Knob — 270° sweep, value arc from min (or from
// center when `bipolar`), accent arc for the live value plus a small ghost
// dot marking `base()` when automation moves the live value away from it
// (the M3 `automated` display; harmless and truthful before M3 too, since
// live == base whenever the param is free).

import type { ParamHandle } from "../../types";
import { toNormalized } from "../../params/taper";
import { ParamControl } from "./ParamControl";

const SWEEP_DEG = 270;
const START_DEG = 135; // arc runs 135° -> 405° (i.e. through the top)

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
  testId?: string | undefined;
  onShowAutomation?: (() => void) | undefined;
}

export function Knob({ handle, size = 36, label, testId, onShowAutomation }: KnobProps) {
  const desc = handle.desc;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;

  return (
    <ParamControl handle={handle} testId={testId} onShowAutomation={onShowAutomation} title={desc.label}>
      {(value) => {
        const n = toNormalized(desc, value);
        const nBase = toNormalized(desc, handle.base());
        const zero = desc.bipolar === true ? 0.5 : 0;
        const valueArc = arcPath(cx, cy, r, angleOf(Math.min(zero, n)), angleOf(Math.max(zero, n)));
        const tip = polar(cx, cy, r - 3, angleOf(n));
        const ghost = polar(cx, cy, r + 1, angleOf(nBase));
        const showGhost = Math.abs(nBase - n) > 0.01; // automation drift only
        return (
          <>
            <svg width={size} height={size} aria-hidden="true">
              <path d={arcPath(cx, cy, r, START_DEG, START_DEG + SWEEP_DEG)} stroke="#333" strokeWidth={3} fill="none" />
              {valueArc !== "" && <path d={valueArc} stroke="#5aa9e6" strokeWidth={3} fill="none" />}
              <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke="#ddd" strokeWidth={2} strokeLinecap="round" />
              {showGhost && <circle cx={ghost.x} cy={ghost.y} r={2} fill="#f2c14e" />}
            </svg>
            <span style={{ fontSize: 10, color: "#999", lineHeight: 1.1, maxWidth: size + 16, textAlign: "center" }}>
              {label ?? desc.label}
            </span>
          </>
        );
      }}
    </ParamControl>
  );
}
