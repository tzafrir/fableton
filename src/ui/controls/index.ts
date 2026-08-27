// SS5 — the control kit's public surface, plus the kind -> control picker
// the SS5 default panel generator uses ("kind -> control, four per row").

import type { ControlKind, ParamDescriptor } from "../../types";

export { createControlGesture, DRAG_FULL_SWEEP_PX, FINE_FACTOR, KEY_STEP, PAGE_STEP, WHEEL_STEP } from "./gesture";
export type { ControlGesture } from "./gesture";
export { ParamControl, useParamValue } from "./ParamControl";
export { Knob } from "./Knob";
export { Fader, FADER_DETENT_DB, FADER_DETENT_SNAP_DB } from "./Fader";
export { EnumSelect, ToggleLED } from "./EnumSelect";

/** SS5 default panel rule: which control a descriptor gets when its panel
 *  row doesn't say. Stepped params reuse the knob (its gesture detents). */
export function controlKindFor(desc: ParamDescriptor): ControlKind {
  switch (desc.kind) {
    case "toggle":
      return "toggle";
    case "enum":
      return "enumSelect";
    case "stepped":
      return "steppedKnob";
    case "continuous":
      return "knob";
  }
}
