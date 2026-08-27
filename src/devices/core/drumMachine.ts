// `core.drum-machine` — eight synthesised drum voices on one instrument,
// each triggered by its own MIDI note.
//
// WHY ONE DEVICE AND NOT A DRUM RACK. A rack (SS7, see src/state/commands/
// racks.ts) routes AUDIO into parallel chains; a drum rack additionally has
// to route NOTES — pad by pad — into a different instrument per chain, and a
// channel has exactly one instrument slot (`Channel.source`). This device
// does the note routing internally instead: one instrument, one slot, eight
// engines, and the pads are addressable from the piano roll on day one.
// Putting an effect rack after it gives the other half of what a drum rack
// is for.
//
// PAD MAPPING is General MIDI's, not a contiguous block starting at C1:
// notes written for GM drums (or imported from anywhere) land on the right
// pads, and the piano roll's key strip names them. The map is `PADS` below.
//
// Every pad exposes the same three controls — tune, decay, level — because
// those are the three that get touched while writing a beat. Engine-specific
// character (a kick's pitch sweep, a hat's tone) is baked into the voice at
// a musically sensible value rather than being another 24 knobs.

import type { DeviceDefinition, DeviceInstance, PanelSpec, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
import { clapHit, hatHit, kickHit, midiToHz, rimHit, snareHit } from "./drumVoices";

export type PadEngine = "kick" | "snare" | "clap" | "rim" | "hat" | "tom";

export interface PadSpec {
  /** Local param prefix, e.g. `kick` -> `kickTune` / `kickDecay` / `kickLevel`. */
  id: string;
  label: string;
  /** The MIDI note that fires it (General MIDI). */
  note: number;
  engine: PadEngine;
  /** Body pitch at tune 0, as a MIDI note — what `midiToHz` is given. */
  basePitch: number;
  /** Amplitude decay at default, in ms. */
  decayMs: number;
  /** Longest decay this pad allows, in ms (a hat and a tom want very
   *  different ranges, and one shared range would make both awkward). */
  maxDecayMs: number;
}

/** The eight pads, in the order they appear in the panel. */
export const PADS: readonly PadSpec[] = [
  { id: "kick", label: "Kick", note: 36, engine: "kick", basePitch: 36, decayMs: 420, maxDecayMs: 2000 },
  { id: "rim", label: "Rim", note: 37, engine: "rim", basePitch: 60, decayMs: 60, maxDecayMs: 400 },
  { id: "snare", label: "Snare", note: 38, engine: "snare", basePitch: 52, decayMs: 220, maxDecayMs: 1200 },
  { id: "clap", label: "Clap", note: 39, engine: "clap", basePitch: 60, decayMs: 240, maxDecayMs: 1200 },
  { id: "tomLo", label: "Tom Lo", note: 41, engine: "tom", basePitch: 43, decayMs: 500, maxDecayMs: 2000 },
  { id: "hatClosed", label: "Hat", note: 42, engine: "hat", basePitch: 84, decayMs: 70, maxDecayMs: 600 },
  { id: "tomHi", label: "Tom Hi", note: 43, engine: "tom", basePitch: 50, decayMs: 420, maxDecayMs: 2000 },
  { id: "hatOpen", label: "Open Hat", note: 46, engine: "hat", basePitch: 84, decayMs: 420, maxDecayMs: 2000 },
];

const tuneId = (pad: PadSpec): string => `${pad.id}Tune`;
const decayId = (pad: PadSpec): string => `${pad.id}Decay`;
const levelId = (pad: PadSpec): string => `${pad.id}Level`;

/** Pad -> its three params, one labelled row each (SS5 panel rows). */
function drumPanel(): PanelSpec {
  return {
    rows: PADS.map((pad) => ({
      label: `${pad.label}  (${padNoteName(pad.note)})`,
      controls: [{ paramId: tuneId(pad) }, { paramId: decayId(pad) }, { paramId: levelId(pad) }],
    })),
  };
}

/** The same octave numbering the piano roll's key strip uses (MIDI 60 = C3). */
export function padNoteName(note: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((note % 12) + 12) % 12] ?? "?"}${Math.floor(note / 12) - 2}`;
}

export const DrumMachine: DeviceDefinition = {
  id: "core.drum-machine",
  version: 1,
  kind: "instrument",
  label: "Drum Machine",
  audioIn: [],
  audioOut: [{ id: "out" }],
  params: [
    ...PADS.flatMap((pad) => [
      p.st(tuneId(pad), `${pad.label} Tune`, { min: -24, max: 24, default: 0 }),
      p.ms(decayId(pad), `${pad.label} Decay`, { min: 10, max: pad.maxDecayMs, default: pad.decayMs }),
      p.db(levelId(pad), `${pad.label} Level`, { min: -60, max: 6, default: 0 }),
    ]),
    p.db("gain", "Gain", { min: -60, max: 6, default: -3 }),
  ],
  panel: drumPanel(),

  create(ctx, io): DeviceInstance {
    const outGain = ctx.createGain();
    outGain.connect(io.out);

    /** Live pad state the next hit reads, seeded from the descriptors so a
     *  hit before the first param push still sounds right. */
    const state = new Map<string, { tune: number; decayS: number; level: number }>();
    for (const pad of PADS) {
      state.set(pad.id, { tune: 0, decayS: pad.decayMs / 1000, level: 1 });
    }
    const byNote = new Map<number, PadSpec>(PADS.map((pad) => [pad.note, pad]));

    return deviceInstance({
      gainParams: { gain: outGain },
      connectParam: (localId, handle) => {
        for (const pad of PADS) {
          const live = state.get(pad.id);
          if (live === undefined) continue;
          if (localId === tuneId(pad)) {
            handle.bindMessage((v) => void (live.tune = v));
            return;
          }
          if (localId === decayId(pad)) {
            handle.bindMessage((v) => void (live.decayS = v / 1000));
            return;
          }
          if (localId === levelId(pad)) {
            // dB -> linear here rather than through `gainParams`, because a
            // pad has no node of its own: its level rides each hit.
            handle.bindMessage((db) => void (live.level = db <= -60 ? 0 : 10 ** (db / 20)));
            return;
          }
        }
      },

      noteOn: (pitch, vel, when) => {
        const pad = byNote.get(pitch);
        if (pad === undefined) return; // notes outside the map are silent
        const live = state.get(pad.id);
        if (live === undefined) return;
        const at = Math.max(when, ctx.currentTime);
        const base = {
          ctx,
          out: outGain,
          at,
          level: (vel / 127) * live.level,
          hz: midiToHz(pad.basePitch + live.tune),
          decayS: live.decayS,
        };
        switch (pad.engine) {
          case "kick":
            kickHit({ ...base, sweepSemitones: 26, pitchDecayS: 0.045, clickAmount: 0.3 });
            break;
          case "tom":
            // A tom is a kick with a shallower, slower drop and no click.
            kickHit({ ...base, sweepSemitones: 8, pitchDecayS: 0.12, clickAmount: 0 });
            break;
          case "snare":
            snareHit({ ...base, snappy: 0.7 });
            break;
          case "clap":
            clapHit(base);
            break;
          case "rim":
            rimHit(base);
            break;
          case "hat":
            hatHit({ ...base, toneHz: Math.max(200, base.hz * 0.9) });
            break;
        }
      },

      // Drums have no note-off (see drumVoices.ts): a hit rings for its decay.

      dispose: (when?: Seconds): void => {
        rampOutAndDisconnect(when, [outGain], { context: ctx });
      },
    });
  },
};
