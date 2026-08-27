// SS4 + SS8 — song-level edits: param values, tempo, meter, loop brace, name.
//
// `setParamValue` is the ONE document write on the SS3 param fast path: a knob
// drag writes through `ParamHandle.setLive` at gesture rate and lands here
// exactly once, at `commit()` (see ../paramBridge).

import type {
  Command,
  LoopRegion,
  ParamId,
  ProjectCommands,
  TimeSignature,
} from "../../types";
import { makeCommand, tick } from "./util";

export type SongCommands = Pick<
  ProjectCommands,
  | "setParamValue"
  | "setParamValues"
  | "renameProject"
  | "setTempo"
  | "setTimeSignature"
  | "setLoopRegion"
  | "custom"
>;

/** SS8 sanity bounds for the single v1 tempo segment. */
export const MIN_BPM = 20;
export const MAX_BPM = 999;

export function createSongCommands(): SongCommands {
  return {
    setParamValue(paramId: ParamId, value: number): Command {
      return makeCommand("Set Parameter", (doc) => {
        if (!Number.isFinite(value)) return;
        // Real units (SS4). Range/step clamping belongs to the descriptor and
        // has already happened in the registry.
        doc.paramValues[paramId] = value;
      });
    },

    setParamValues(values: Readonly<Record<ParamId, number>>): Command {
      const entries = Object.entries(values).filter(([, value]) => Number.isFinite(value));
      return makeCommand("Set Parameters", (doc) => {
        for (const [paramId, value] of entries) doc.paramValues[paramId] = value;
      });
    },

    renameProject(name: string): Command {
      return makeCommand(
        "Rename Project",
        (doc) => {
          doc.name = name;
        },
        { coalesceKey: "project.name" },
      );
    },

    setTempo(bpm: number): Command {
      const clamped = Math.min(MAX_BPM, Math.max(MIN_BPM, Number.isFinite(bpm) ? bpm : MIN_BPM));
      return makeCommand(
        "Set Tempo",
        (doc) => {
          // v1 is a single fixed segment starting at tick 0 (invariant 1).
          const first = doc.tempo[0];
          if (doc.tempo.length === 1 && first !== undefined) {
            first.startTick = 0;
            first.bpm = clamped;
            return;
          }
          doc.tempo = [{ startTick: 0, bpm: clamped }];
        },
        // Typing "128" into a tempo field is ONE edit, not three (SS13
        // `coalesceKey`) — the same treatment `renameProject` gets, and for
        // the same reason: a per-keystroke undo stack is unusable.
        { coalesceKey: "song.tempo" },
      );
    },

    setTimeSignature(signature: TimeSignature): Command {
      const numerator = Math.max(1, Math.round(signature.numerator));
      const denominator = Math.max(1, Math.round(signature.denominator));
      return makeCommand(
        "Set Time Signature",
        (doc) => {
          doc.timeSignature.numerator = numerator;
          doc.timeSignature.denominator = denominator;
        },
        { coalesceKey: "song.timeSignature" },
      );
    },

    setLoopRegion(loop: LoopRegion): Command {
      const start = Math.max(0, tick(loop.start));
      const end = Math.max(start, tick(loop.end));
      const enabled = loop.enabled === true;
      return makeCommand("Set Loop", (doc) => {
        doc.loop.start = start;
        doc.loop.end = end;
        doc.loop.enabled = enabled;
      });
    },

    custom(label, run): Command {
      return makeCommand(label, run);
    },
  };
}
