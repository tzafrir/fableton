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
export { Distortion, Overdrive } from "./overdrive";
export { DrumMachine, PADS } from "./drumMachine";
export { Filter } from "./filter";
export { Gate } from "./gate";
export { FmSynth } from "./fmSynth";
export { Kick } from "./kick";
export { PolySynth } from "./polySynth";
export { Compressor } from "./compressor";
export { Eq3 } from "./eq3";
export { Pluck } from "./pluck";
export { Reverb } from "./reverb";
export { Saturator } from "./saturator";
export { StereoDelay } from "./stereoDelay";

import { Compressor } from "./compressor";
import { DrumMachine } from "./drumMachine";
import { FmSynth } from "./fmSynth";
import { Kick } from "./kick";
import { Distortion, Overdrive } from "./overdrive";
import { Eq3 } from "./eq3";
import { Filter } from "./filter";
import { Gate } from "./gate";
import { Pluck } from "./pluck";
import { PolySynth } from "./polySynth";
import { Reverb } from "./reverb";
import { Saturator } from "./saturator";
import { StereoDelay } from "./stereoDelay";

/** Every `DeviceDefinition` this package ships, in registration order —
 *  M0's two plus the SS18-M4 library (compressor with SC, EQ, delay,
 *  reverb, saturator, second instrument), plus the FM/kick/drum
 *  instruments and the two clipping effects. */
export const CORE_DEVICES = [
  PolySynth,
  Pluck,
  FmSynth,
  Kick,
  DrumMachine,
  Filter,
  Eq3,
  Compressor,
  StereoDelay,
  Reverb,
  Saturator,
  Overdrive,
  Distortion,
  Gate,
] as const;
