// SS5 control inventory: Fader — mixer volume (dB taper), slim variant for
// sends. 0 dB detent line; drag snaps within ±0.5 dB of the detent unless
// `Shift` (the snap runs through `ParamControl.snapDragValue`, which fine
// mode bypasses by contract).

import type { ParamHandle } from "../../types";
import { toNormalized } from "../../params/taper";
import { ARC_ACCENT, ARC_OVERRIDDEN, ParamControl } from "./ParamControl";
import { INK } from "../theme";

const RAIL = "#05070b";
const DETENT = INK.lineStrong;
const CAP = "#c6cddc";
const CAP_EDGE = "#0a0d13";
const CAP_GRIP = "#7c8496";

export const FADER_DETENT_DB = 0;
export const FADER_DETENT_SNAP_DB = 0.5;

export interface FaderProps {
  handle: ParamHandle;
  height?: number | undefined;
  slim?: boolean | undefined;
  testId?: string | undefined;
  onShowAutomation?: (() => void) | undefined;
  hasAutomation?: boolean | undefined;
}

function snapToDetent(value: number): number {
  return Math.abs(value - FADER_DETENT_DB) <= FADER_DETENT_SNAP_DB ? FADER_DETENT_DB : value;
}

export function Fader({
  handle,
  height = 96,
  slim = false,
  testId,
  onShowAutomation,
  hasAutomation,
}: FaderProps) {
  const desc = handle.desc;
  const capW = slim ? 12 : 20;
  const capH = slim ? 8 : 11;
  const boxW = capW + 12;
  const midX = boxW / 2;
  const detentN = toNormalized(desc, FADER_DETENT_DB);

  return (
    <ParamControl
      handle={handle}
      testId={testId}
      snapDragValue={snapToDetent}
      onShowAutomation={onShowAutomation}
      hasAutomation={hasAutomation}
      title={desc.label}
      // A fader's label is its number: "Volume" under the volume fader says
      // nothing the strip has not already said, and the dB it is sitting at
      // was previously unreadable without grabbing it. Same line, same
      // click-to-type — it just never swaps away from the value.
      label={desc.label}
      labelShowsValue
      labelMaxWidth={slim ? 34 : 48}
    >
      {(value, _dragging, state) => {
        const n = toNormalized(desc, value);
        const y = (1 - n) * height;
        // SS5: an overridden param's fill dims and pulses, same language as
        // the knob's arc — the lane is still playing, this control just isn't
        // listening to it until *Re-enable automation*.
        const overridden = state === "overridden";
        const fill = overridden ? ARC_OVERRIDDEN : ARC_ACCENT;
        const detentY = 5 + (1 - detentN) * height;
        return (
          <svg width={boxW} height={height + 10} aria-hidden="true" style={{ display: "block" }}>
            {/* rail — recessed, so the cap reads as sitting IN it */}
            <rect x={midX - 2.5} y={5} width={5} height={height} rx={2.5} fill={RAIL} />
            {/* travelled portion */}
            <rect
              x={midX - 2.5}
              y={5 + y}
              width={5}
              height={height - y}
              rx={2.5}
              fill={fill}
              data-param-arc={overridden ? "overridden" : "live"}
              style={overridden ? undefined : { filter: `drop-shadow(0 0 3px ${fill}77)` }}
            >
              {overridden && (
                <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
              )}
            </rect>
            {/* 0 dB detent — unity is the one position worth marking */}
            <line x1={2} x2={boxW - 2} y1={detentY} y2={detentY} stroke={DETENT} strokeWidth={1} />
            {/* cap, with a grip line across it */}
            <rect
              x={midX - capW / 2}
              y={5 + y - capH / 2}
              width={capW}
              height={capH}
              rx={2.5}
              fill={CAP}
              stroke={CAP_EDGE}
            />
            <line
              x1={midX - capW / 2 + 3}
              x2={midX + capW / 2 - 3}
              y1={5 + y}
              y2={5 + y}
              stroke={CAP_GRIP}
              strokeWidth={1}
            />
          </svg>
        );
      }}
    </ParamControl>
  );
}
