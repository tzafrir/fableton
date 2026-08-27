// SS5 control inventory: Fader — mixer volume (dB taper), slim variant for
// sends. 0 dB detent line; drag snaps within ±0.5 dB of the detent unless
// `Shift` (the snap runs through `ParamControl.snapDragValue`, which fine
// mode bypasses by contract).

import type { ParamHandle } from "../../types";
import { toNormalized } from "../../params/taper";
import { ARC_ACCENT, ARC_OVERRIDDEN, ParamControl } from "./ParamControl";

export const FADER_DETENT_DB = 0;
export const FADER_DETENT_SNAP_DB = 0.5;

export interface FaderProps {
  handle: ParamHandle;
  height?: number | undefined;
  slim?: boolean | undefined;
  testId?: string | undefined;
  onShowAutomation?: (() => void) | undefined;
}

function snapToDetent(value: number): number {
  return Math.abs(value - FADER_DETENT_DB) <= FADER_DETENT_SNAP_DB ? FADER_DETENT_DB : value;
}

export function Fader({ handle, height = 96, slim = false, testId, onShowAutomation }: FaderProps) {
  const desc = handle.desc;
  const width = slim ? 10 : 16;
  const detentN = toNormalized(desc, FADER_DETENT_DB);

  return (
    <ParamControl
      handle={handle}
      testId={testId}
      snapDragValue={snapToDetent}
      onShowAutomation={onShowAutomation}
      title={desc.label}
    >
      {(value, _dragging, state) => {
        const n = toNormalized(desc, value);
        const y = (1 - n) * height;
        // SS5: an overridden param's fill dims and pulses, same language as
        // the knob's arc — the lane is still playing, this control just isn't
        // listening to it until *Re-enable automation*.
        const overridden = state === "overridden";
        return (
          <svg width={width + 12} height={height + 10} aria-hidden="true">
            {/* rail */}
            <rect x={(width + 12) / 2 - 2} y={5} width={4} height={height} rx={2} fill="#2a2a2a" />
            {/* filled portion */}
            <rect
              x={(width + 12) / 2 - 2}
              y={5 + y}
              width={4}
              height={height - y}
              rx={2}
              fill={overridden ? ARC_OVERRIDDEN : ARC_ACCENT}
              data-param-arc={overridden ? "overridden" : "live"}
            >
              {overridden && (
                <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
              )}
            </rect>
            {/* 0 dB detent line */}
            <line
              x1={2}
              x2={width + 10}
              y1={5 + (1 - detentN) * height}
              y2={5 + (1 - detentN) * height}
              stroke="#555"
              strokeWidth={1}
            />
            {/* handle */}
            <rect x={(width + 12) / 2 - width / 2} y={5 + y - 4} width={width} height={8} rx={2} fill="#ccc" />
          </svg>
        );
      }}
    </ParamControl>
  );
}
