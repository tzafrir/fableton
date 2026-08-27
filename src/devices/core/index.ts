// Core devices (SS7/SS14). M0 ships one poly synth + one filter effect as
// definitions here — the two entries `device-harness`'s registry (or
// whatever boots the app) registers to make M0's hard-coded clip audible.
//
// Both are written the way the SS14 playbook writes a device — `p.*`
// descriptors plus `deviceInstance({...})` / `rampOutAndDisconnect` from the
// harness — so the files a future device author imitates are the same seam
// the playbook advertises. See ./polySynth.ts and ./filter.ts.

// Only the definitions themselves cross this barrel. A device's enum
// mapping, its worklet's processor name and the rest of its internals stay
// inside its own file: SS7 — "nothing else in the app knows what a device does
// internally", and SS4 makes `ParamDescriptor.labels` on the registered handle
// the sanctioned channel for enum choices.
export { Filter } from "./filter";
export { PolySynth } from "./polySynth";

import { Filter } from "./filter";
import { PolySynth } from "./polySynth";

/** Every `DeviceDefinition` this package ships, in registration order. */
export const CORE_DEVICES = [PolySynth, Filter] as const;
