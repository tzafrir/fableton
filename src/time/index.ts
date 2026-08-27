// Musical time model (SS8): integer ticks at 960 PPQ, TempoMap piecewise
// tick<->seconds conversion, and grid math (bar/beat/tick, note-value
// subdivision, snapping). `PPQ` / `TICKS_PER_WHOLE_NOTE` are re-exported
// from `../types` verbatim — this package never redeclares them.

export { PPQ, TICKS_PER_WHOLE_NOTE } from "../types";
export type {
  BarBeatTick,
  Bpm,
  TempoMap,
  TempoSegment,
  TimeSignature,
  Ticks,
} from "../types";

export { createFixedTempoMap, createTempoMap } from "./tempoMap";

export type { SnapMode } from "./grid";
export {
  barBeatTickToTick,
  formatBarBeatTick,
  snapTicks,
  tickToBarBeatTick,
  ticksPerBar,
  ticksPerBeat,
  ticksPerNote,
} from "./grid";
