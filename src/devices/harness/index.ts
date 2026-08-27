// Device harness (SS7): the shared shape every device — instrument or effect —
// is built against, and the one place the SS7 lifecycle runs.
//
// A device author writes ONE file (SS14): a `DeviceDefinition` whose `params`
// are `p.*` one-liners and whose `create(ctx, io)` returns `deviceInstance({
// audioParams, gainParams, dispose })`. Everything else — port nodes, param
// registration under `chan:<id>/dev:<id>/<localId>`, fast-path binding,
// worklet `prepare`, gain-ramped removal — is the harness's job and arrives
// with zero further work.

export { p } from "./params";
export type { DefaultOption, DescriptorOptions, RangeOptions } from "./params";

export {
  DEFAULT_RAMP_OUT_MS,
  createDeviceInstance,
  dbToGain,
  deviceInstance,
  gainForValue,
  mappedParam,
  msParam,
  rampOutAndDisconnect,
  scaledParam,
} from "./deviceInstance";
export type {
  DelayedCall,
  GainTarget,
  HarnessDeviceInstanceSpec,
  RampOutOptions,
  ScaledAudioParam,
} from "./deviceInstance";

export { PRIMARY_IN, PRIMARY_OUT, createDeviceIO } from "./io";
export type { DeviceIOBundle, PortDeclarations } from "./io";

export { createDeviceRegistry, validateDefinition } from "./registry";
export type { AppDeviceRegistry } from "./registry";

export { createDeviceHost, createHost, prepareDefinition } from "./host";
export type { AppDeviceHost, DeviceHostOptions } from "./host";
