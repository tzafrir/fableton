// SS11 "Playback — two paths, chosen by the binding" — the automation
// sampler, attached to the transport as a `WindowFiller` (the seam the
// transport shipped in M0 precisely for this).
//
// Per scheduling window `(horizonSeconds, fromTick, toTick)` and per enabled
// lane, the lane is sampled (curve.ts) and the samples handed to the
// registry's `scheduleAutomation`, which routes them down whichever fast
// path the param is bound to:
//   - AudioParam: `cancelAndHoldAtTime` + `linearRampToValueAtTime` chunks —
//     bent segments arrive pre-subdivided, so linear chunks trace the bend
//     (the SS11 `setValueCurveAtTime` variant with the same audible result
//     and none of that call's overlap restrictions);
//   - message: timestamped values at ~200 Hz control rate (SS11), the
//     worklet interpolating between them.
// Overridden params drop their writes inside the handle (SS4).
//
// Tick -> seconds inside a window: the window's END is `horizonSeconds`, so
// `secondsFor(tick) = horizonSeconds - tempo.secondsBetween(tick, toTick)`.
// This holds across loop wraps because the transport emits one window per
// contiguous scheduling pass.
//
// A lane EDIT during playback shows up here as `setLanes` with new points;
// already-scheduled audio keeps the old curve for at most one look-ahead
// window (~200 ms), after which the next window's `cancelAndHoldAtTime`
// reconciles — the SS11 "reschedule the remainder" behaviour at window
// granularity.

import type { AutomationLane, Immutable, ParamId, Seconds, TempoMap, Ticks, WindowFiller } from "../../types";

/** The sampler only READS lanes, so it accepts the store's immutable view. */
export type LaneView = Immutable<AutomationLane>;
import type { AppParamRegistry } from "../../params";
import { laneValueAt, sampleLane, type AutomationSample } from "./curve";

/** SS11 message-path control rate. */
export const CONTROL_RATE_HZ = 200;
/** AudioParam ramps can afford coarser subdivision of bends (~60/s at 120bpm). */
const AUDIO_PARAM_STEP_TICKS = 32;

export interface AutomationSampler extends WindowFiller {
  /** The document's lanes (the sampler filters to enabled ones itself). */
  setLanes(lanes: readonly LaneView[]): void;
  /** Ids the registry should mark `automated` — enabled lanes' params. */
  automatedIds(): ReadonlySet<ParamId>;
  /** Moving-knob display: pushes each lane's value AT `positionTicks` to
   *  the registry's display path. Call from the UI clock (rAF). */
  updateDisplay(positionTicks: Ticks): void;
}

export interface AutomationSamplerDeps {
  registry: AppParamRegistry;
  /** Live tempo map (the engine swaps it on document change). */
  tempoMap: () => TempoMap;
  /** Message-path params need control-rate sampling; the registry knows the
   *  binding but does not expose it — the engine tells the sampler which
   *  params are message-bound. Defaults to "none" (AudioParam granularity). */
  isMessageBound?: ((id: ParamId) => boolean) | undefined;
}

export function createAutomationSampler(deps: AutomationSamplerDeps): AutomationSampler {
  const { registry } = deps;
  const isMessageBound = deps.isMessageBound ?? (() => false);
  let enabled: LaneView[] = [];
  let ids = new Set<ParamId>();

  // Reused across windows — SS12's zero-allocation-in-tick-paths guardrail.
  const scratch: AutomationSample[] = [];
  const sendBuffer: { value: number; when: Seconds }[] = [];

  return {
    setLanes(lanes: readonly LaneView[]): void {
      enabled = lanes.filter((lane) => lane.enabled && lane.points.length > 0);
      ids = new Set(enabled.map((lane) => lane.paramId));
    },

    automatedIds(): ReadonlySet<ParamId> {
      return ids;
    },

    fillWindow(horizonSeconds: Seconds, fromTick: Ticks, toTick: Ticks): void {
      if (enabled.length === 0 || toTick <= fromTick) return;
      const tempo = deps.tempoMap();
      for (const lane of enabled) {
        const message = isMessageBound(lane.paramId);
        const stepTicks = message
          ? Math.max(1, Math.round(tempo.ticksAt(1 / CONTROL_RATE_HZ)))
          : AUDIO_PARAM_STEP_TICKS;
        const samples = sampleLane(lane.points, fromTick, toTick, stepTicks, scratch, message);
        if (samples.length === 0) continue;
        sendBuffer.length = 0;
        for (const s of samples) {
          sendBuffer.push({
            value: s.value,
            when: horizonSeconds - tempo.secondsBetween(s.tick, toTick),
          });
        }
        registry.scheduleAutomation(lane.paramId, sendBuffer);
      }
    },

    updateDisplay(positionTicks: Ticks): void {
      for (const lane of enabled) {
        const value = laneValueAt(lane.points, positionTicks);
        if (value !== undefined) registry.displayAutomation(lane.paramId, value);
      }
    },
  };
}
