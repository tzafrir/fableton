// Factory rack presets (SS7 racks): named parallel-chain patches that a
// single menu entry builds, as one undoable command (`addRackPreset`).
//
// A DEVICE preset is a bag of values for an instance that already exists
// (SS4); a RACK preset has to create the instances, wire them in parallel and
// add the routing edges between them — which is why it lives in the command
// vocabulary rather than in `presetStore`.

import type { RackPresetSpec } from "../types";

/**
 * The patch the whole racks plan was aimed at.
 *
 *   chain 1: dry (empty — the split's own signal)
 *   chain 2: Reverb -> Gate, the gate KEYED FROM THE CHANNEL'S PRE-FX TAP
 *
 * The key is what makes it "gated" rather than "a reverb with a gate on it":
 * the door is opened by the DRY hit, so the tail is cut off the instant the
 * hit stops rather than decaying naturally. That same-channel `preFx` key is
 * feed-forward (the tap sits upstream of the whole chain), which is exactly
 * the case Phase 0 narrowed the cycle rule to allow.
 *
 * The values are the classic 80s setting: a big bright room, a fast door
 * with almost no hold, and a hard floor so the tail stops dead.
 */
export const GATED_REVERB: RackPresetSpec = {
  name: "Gated Reverb",
  chains: [
    { name: "Dry", devices: [] },
    {
      name: "Gated Verb",
      devices: [
        // `size` is in SECONDS (0.1..8) and `mix` a percentage. Fully wet:
        // the dry signal is the rack's other chain, so a wet/dry mix inside
        // this one would just add a second, ungated copy of it.
        { definitionId: "core.reverb", params: { size: 2.4, mix: 100 } },
        {
          definitionId: "core.gate",
          params: { threshold: -34, attack: 0.3, hold: 30, release: 60, floor: -60 },
          sidechainFromHost: "preFx",
        },
      ],
    },
  ],
};

/** Every factory rack, in menu order. */
export const FACTORY_RACKS: readonly RackPresetSpec[] = [GATED_REVERB];
