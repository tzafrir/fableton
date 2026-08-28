// `core.wavetable` — a two-oscillator wavetable synth with a two-filter
// section and a modulation matrix, written the way SS14's playbook writes an
// instrument and the way `core.poly-synth` writes a worklet one: `p.*`
// descriptors (here, ./wavetable/params.ts), `deviceInstance({...})` for the
// binding table, `rampOutAndDisconnect` for a click-free teardown.
//
// This file is deliberately thin. All of it — the tables, the oscillator, the
// filters, the LFOs, the matrix, the voice pool — lives in ./wavetable/* as
// plain math, and the audio-thread composition lives in
// ../../worklets/wavetable-processor.ts. What is left here is the two things
// only the main thread can do:
//
//   BUILD THE TABLES. A wavetable is sixteen single-cycle waveforms, each
//   stored at eight band-limited resolutions — a few hundred kilobytes and a
//   hundred-odd FFTs per table. That is not work for the render thread, and
//   it is not work to repeat: tables are built on demand, cached, and posted
//   across once. Selecting a table already sent costs one small message.
//
//   HOLD THE NOTE PLUMBING. Same preallocated-message trick the poly synth
//   uses (SS12: nothing allocates in a per-tick path).

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
// The SS15 worklet-bundling seam — see ./polySynth.ts for why `?worker&url`
// rather than `?url` is the suffix that actually transpiles the module.
import wavetableWorkletUrl from "../../worklets/wavetable-processor.ts?worker&url";
import { AUDIO_PARAM_IDS, WAVETABLE_PARAMS, oscParamIds } from "./wavetable/params";
import { WAVETABLE_PROCESSOR_NAME } from "./wavetable/processorName";
import { WAVETABLES, buildWavetable } from "./wavetable/tables";

export { WAVETABLE_PROCESSOR_NAME };

export const WavetableSynth: DeviceDefinition = {
  id: "core.wavetable",
  version: 1,
  kind: "instrument",
  label: "Wavetable",
  audioIn: [],
  audioOut: [{ id: "out" }],
  editor: "wavetable",
  params: [...WAVETABLE_PARAMS],

  async prepare(ctx): Promise<void> {
    await ctx.audioWorklet.addModule(wavetableWorkletUrl);
  },

  create(ctx, io): DeviceInstance {
    const node = new AudioWorkletNode(ctx, WAVETABLE_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    // An owned output gain so `dispose` can fade over the harness's ramp
    // rather than leaving the worklet ringing its release into a port node
    // the harness hard-disconnects underneath it (SS7).
    const outGain = ctx.createGain();
    node.connect(outGain);
    outGain.connect(io.out);

    const noteOnMessage = { type: "noteOn", pitch: 0, vel: 0, when: 0 };
    const noteOffMessage = { type: "noteOff", pitch: 0, when: 0 };
    const allNotesOffMessage = { type: "allNotesOff", when: 0 };
    const selectMessage = { type: "osc", osc: 0, index: 0 };

    /** Catalogue indices already posted, so a table crosses once. */
    const sentTables = new Set<number>();
    /** What each oscillator is already on. A `table` param can carry an
     *  automation lane, and a lane writes its value every frame — without
     *  this, a static lane would post sixty select messages a second. */
    const selected = [-1, -1];

    const selectTable = (osc: number, raw: number): void => {
      const index = Math.min(WAVETABLES.length - 1, Math.max(0, Math.round(raw)));
      if (selected[osc] === index) return;
      selected[osc] = index;
      if (!sentTables.has(index)) {
        // Structured-cloned rather than transferred: the same `WavetableData`
        // is what the editor draws from (they share one cache), and
        // transferring would detach the buffers out from under the display.
        node.port.postMessage({ type: "table", index, data: buildWavetable(index) });
        sentTables.add(index);
      }
      selectMessage.osc = osc;
      selectMessage.index = index;
      node.port.postMessage(selectMessage);
    };

    const audioParams: Record<string, AudioParam> = {};
    for (const localId of AUDIO_PARAM_IDS) {
      const audioParam = node.parameters.get(localId);
      if (audioParam === undefined) {
        throw new Error(`core.wavetable: worklet is missing AudioParam "${localId}"`);
      }
      audioParams[localId] = audioParam;
    }

    return deviceInstance({
      audioParams,
      messageParams: {
        [oscParamIds(0).table]: (value: number) => {
          selectTable(0, value);
        },
        [oscParamIds(1).table]: (value: number) => {
          selectTable(1, value);
        },
      },
      noteOn: (pitch: number, vel: number, when: Seconds): void => {
        noteOnMessage.pitch = pitch;
        noteOnMessage.vel = vel;
        noteOnMessage.when = when;
        node.port.postMessage(noteOnMessage);
      },
      noteOff: (pitch: number, when: Seconds): void => {
        noteOffMessage.pitch = pitch;
        noteOffMessage.when = when;
        node.port.postMessage(noteOffMessage);
      },
      allNotesOff: (when: Seconds): void => {
        allNotesOffMessage.when = when;
        node.port.postMessage(allNotesOffMessage);
      },
      dispose: (when?: Seconds): void => {
        const now = ctx.currentTime;
        const at = when !== undefined && Number.isFinite(when) && when > now ? when : now;
        allNotesOffMessage.when = at;
        node.port.postMessage(allNotesOffMessage);
        rampOutAndDisconnect(at, [outGain], { context: ctx, also: [node] });
      },
    });
  },
};
