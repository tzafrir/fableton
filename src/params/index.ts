// `param-registry` (SS4, load-bearing) — the spine.
//
// Everything tweakable in the app is a `ParamDescriptor` registered here and
// driven through a `ParamHandle`. Design rule (SS4): no device, mixer, or
// engine code ever exposes a raw `AudioParam` or setter to the UI — an
// `AudioParam` goes INTO `handle.bindAudioParam(...)` and never comes back
// out. This package also owns every `ParamId` string (build + parse) and the
// one real<->normalized taper boundary.

export {
  PARAM_PATH_SEPARATOR,
  PAN_LEAF,
  VOLUME_LEAF,
  deviceParamId,
  isChannelParamId,
  isDeviceParamId,
  localParamId,
  panParamId,
  parseParamId,
  qualifyDescriptor,
  sendParamId,
  volumeParamId,
  withParamId,
} from "./paramIds";
export type { ParsedParamId } from "./paramIds";

export {
  assertTaperUsable,
  clampToDescriptor,
  fromNormalized,
  taperMapping,
  toNormalized,
} from "./taper";

export { p } from "./descriptors";
export type { DefaultOption, DescriptorOptions, RangeOptions } from "./descriptors";

export {
  DB_SILENCE_FLOOR,
  dbSilenceFloor,
  formatDb,
  formatHz,
  formatMs,
  formatPan,
  formatPercent,
  formatSemitones,
  parseNumeric,
  parsePan,
  trimNumber,
} from "./text";
export type { SuffixTable } from "./text";

// `writeAudioParam` (the raw-`AudioParam` setter the SS4 design rule names)
// and `ParamHandleImpl` (whose `setBase`/`setAutomated`/`unbind` are the
// registry's private write path) are deliberately NOT on this barrel: this is
// the module the UI imports from (`src/app/App.tsx`). The two callers that
// legitimately need them — the device harness and the registry — deep-import
// `./handle` instead, so the setter never appears in the UI's import surface.
export { DEFAULT_SMOOTHING_MS } from "./handle";
export type { BindAudioParamOptions, ParamHandleHost, RegistryParamHandle } from "./handle";

export { createFrameBatcher } from "./frame";
export type {
  FrameBatcher,
  FrameCanceller,
  FrameScheduler,
  FrameSchedulerOptions,
} from "./frame";

export { createParamRegistry, registerWithValue } from "./registry";
export type { AppParamRegistry, ParamCommit, ParamRegistryOptions } from "./registry";
