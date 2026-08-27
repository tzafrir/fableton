// `core.kick` — a tuned kick drum, played chromatically.
//
// The point of the "tuning/note" in its name: the MIDI note IS the body
// pitch. C1 is a ~65 Hz kick, C2 is an octave up, and `tune` shifts the whole
// instrument in semitones on top — so a kick can be written into the piano
// roll as a melodic part (808 bass lines are exactly this device played up
// the keyboard) rather than being a single fixed thud.
//
// Monophonic on purpose: a real kick drum has one skin. Retriggering chokes
// what is ringing, which is also what makes fast 808 slides work.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { kickHit, midiToHz } from "./drumVoices";

export const Kick: DeviceDefinition = {
  id: "core.kick",
  version: 1,
  kind: "instrument",
  label: "Kick",
  audioIn: [],
  audioOut: [{ id: "out" }],
  params: [
    p.st("tune", "Tune", { min: -24, max: 24, default: 0 }),
    p.continuous("sweep", "Sweep", { min: 0, max: 48, default: 26, unit: "st" }),
    p.ms("pitchDecay", "Pitch Decay", { min: 2, max: 400, default: 45 }),
    p.ms("decay", "Decay", { min: 40, max: 3000, default: 420 }),
    p.pct("click", "Click", { default: 30 }),
    p.db("gain", "Gain", { min: -60, max: 6, default: -3 }),
  ],

  create(ctx, io): DeviceInstance {
    const outGain = ctx.createGain();
    outGain.connect(io.out);

    let tune = 0;
    let sweep = 26;
    let pitchDecayS = 0.045;
    let decayS = 0.42;
    let click = 0.3;

    return deviceInstance({
      gainParams: { gain: outGain },
      connectParam: (localId, handle) => {
        if (localId === "tune") handle.bindMessage((v) => void (tune = v));
        else if (localId === "sweep") handle.bindMessage((v) => void (sweep = v));
        else if (localId === "pitchDecay") handle.bindMessage((v) => void (pitchDecayS = v / 1000));
        else if (localId === "decay") handle.bindMessage((v) => void (decayS = v / 1000));
        else if (localId === "click") handle.bindMessage((v) => void (click = v / 100));
      },

      noteOn: (pitch, vel, when) => {
        kickHit({
          ctx,
          out: outGain,
          at: Math.max(when, ctx.currentTime),
          level: vel / 127,
          hz: midiToHz(pitch + tune),
          decayS,
          sweepSemitones: sweep,
          pitchDecayS,
          clickAmount: click,
        });
      },

      // A drum has no note-off: the hit rings for its decay whether or not
      // the key is still down, so holding a note does not sustain it.

      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx });
      },
    });
  },
};
