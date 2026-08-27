// `core.poly-synth` — the M0 instrument (SS7/SS14, PLAN.md SS18-M0 "one poly
// synth ... as a definition"). DSP runs in an `AudioWorkletProcessor`
// (src/worklets/poly-synth-processor.ts, SS15 "worklets as separate entry
// points"); the pure voice-allocation/envelope/oscillator/filter math it
// runs is factored into ./polySynth/* so it is unit-testable without a
// worklet or a browser (SS15) and shared verbatim by both sides of the
// postMessage boundary.
//
// Written the way SS14's playbook writes an instrument, same as ./filter.ts:
// `p.*` descriptors, `deviceInstance({...})` for the binding table plus the
// note methods, and `rampOutAndDisconnect` for the click-free teardown.

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";
// SS15's worklet-bundling seam — "the only nonstandard bit; solve once in
// M0" — lives here, at the one place M0 actually loads a worklet.
//
// The `?worker&url` suffix is Vite's first-class Worker-file handling
// (vite.dev/guide/features.html#web-workers), used for its transform pipeline
// rather than its usual `new Worker()` auto-construction: the file is
// compiled/minified as a standalone chunk (TS stripped, no shared
// scope/globals with the main bundle — required, since AudioWorklet code runs
// on the audio rendering thread) and the plain URL string is handed back
// instead of a Worker instance, which is what `audioWorklet.addModule(url)`
// needs. Plain `?url` was tried first and rejected: for a non-standard-asset
// extension like `.ts` it only *copies* the raw file (untranspiled TS syntax
// — invalid as a worklet module in the browser); `?worker&url` is the suffix
// that actually routes through esbuild first. Same import, same code path in
// `vite dev` (served on demand) and `vite build` (own emitted chunk, since a
// worklet is never reachable via a static JS `import` — only via
// `addModule(url)` — so it would otherwise be invisible to the bundler).
import polySynthWorkletUrl from "../../worklets/poly-synth-processor.ts?worker&url";
import { OSCILLATOR_SHAPES } from "./polySynth/oscillator";
import { POLY_SYNTH_PROCESSOR_NAME } from "./polySynth/processorName";

export { POLY_SYNTH_PROCESSOR_NAME };

/** Device-local ids that are also the worklet's `parameterDescriptors` names. */
const AUDIO_PARAM_IDS = [
  "shape",
  "cutoff",
  "attack",
  "decay",
  "sustain",
  "release",
  "gain",
  "env2Amount",
  "env2Attack",
  "env2Decay",
  "env2Sustain",
  "env2Release",
] as const;

export const PolySynth: DeviceDefinition = {
  id: "core.poly-synth",
  version: 1,
  kind: "instrument",
  label: "Poly Synth",
  params: [
    p.enum("shape", "Shape", { labels: [...OSCILLATOR_SHAPES] }),
    p.hz("cutoff", "Cutoff", { min: 40, max: 18000, default: 8000 }),
    p.ms("attack", "Attack", { min: 1, max: 4000, default: 5 }),
    p.ms("decay", "Decay", { min: 1, max: 4000, default: 120 }),
    p.percent("sustain", "Sustain", { default: 70 }),
    p.ms("release", "Release", { min: 1, max: 6000, default: 250 }),
    p.db("gain", "Gain", { min: -60, max: 6, default: 0 }),
    // ENV 2 — the filter envelope (the classic second envelope: env 1 is the
    // amp, env 2 opens the filter). Amount is in semitones, and 0 by default,
    // so the synth sounds exactly as before until it is asked for.
    p.st("env2Amount", "Env2 Amount", { min: -48, max: 48, default: 0 }),
    p.ms("env2Attack", "Env2 Attack", { min: 1, max: 4000, default: 5 }),
    p.ms("env2Decay", "Env2 Decay", { min: 1, max: 4000, default: 200 }),
    p.percent("env2Sustain", "Env2 Sustain", { default: 0 }),
    p.ms("env2Release", "Env2 Release", { min: 1, max: 6000, default: 250 }),
  ],
  audioIn: [],
  audioOut: [{ id: "out" }],

  async prepare(ctx): Promise<void> {
    await ctx.audioWorklet.addModule(polySynthWorkletUrl);
  },

  create(ctx, io): DeviceInstance {
    const node = new AudioWorkletNode(ctx, POLY_SYNTH_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    // An owned output gain, exactly as in ./filter.ts: `dispose` fades over
    // the harness's ~20 ms ramp (SS7 "Removal is the reverse, gain-ramped")
    // instead of leaving the worklet ringing its release into a port node the
    // harness hard-disconnects underneath it — that step is an audible click
    // on every instrument swap and on engine teardown.
    const outGain = ctx.createGain();
    node.connect(outGain);
    outGain.connect(io.out);

    // SS12 guardrail — "zero allocation in per-tick paths (preallocated event
    // objects, ring buffers for messages)". The scheduler calls these three
    // methods from inside the tick loop, once per note event (and once per
    // still-pending note on every stop/seek/tempo change), so a fresh object
    // literal per event would be hundreds of allocations a second on the main
    // thread at SS2's 16-track / 40-voice budget. `postMessage` structured-
    // clones synchronously, exactly as src/workers/clock.worker.ts relies on
    // for its own reused `tickMessage`, so one payload per message type can be
    // filled in and re-sent forever.
    //
    // The receiving half (src/worklets/poly-synth-processor.ts) gets a freshly
    // deserialized object per message inside the AudioWorkletGlobalScope: that
    // allocation belongs to the platform's structured clone, and removing it
    // needs a `SharedArrayBuffer` ring (the guardrail's "ring buffers for
    // messages") shared with the audio thread. The COOP/COEP headers that
    // would make one possible are already in place (vite.config.ts, for SS6
    // metering); the ring itself lands with that work, not in M0. The
    // processor already copies each event straight into its preallocated
    // typed-array queue and retains nothing, so the deserialized object dies
    // young and nothing else on the render thread allocates per event.
    const noteOnMessage = { type: "noteOn", pitch: 0, vel: 0, when: 0 };
    const noteOffMessage = { type: "noteOff", pitch: 0, when: 0 };
    const allNotesOffMessage = { type: "allNotesOff", when: 0 };

    // Every declared param is a real k-rate `AudioParam` on the worklet node,
    // so they all take fast path A (SS4) — no message plumbing.
    const audioParams: Record<string, AudioParam> = {};
    for (const localId of AUDIO_PARAM_IDS) {
      const audioParam = node.parameters.get(localId);
      if (audioParam === undefined) {
        throw new Error(`core.poly-synth: worklet is missing AudioParam "${localId}"`);
      }
      audioParams[localId] = audioParam;
    }

    return deviceInstance({
      audioParams,
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
        // `allNotesOff` also cancels every note the look-ahead already queued
        // in the worklet (see polySynth/noteEventQueue.ts), so nothing can
        // attack behind the fade.
        allNotesOffMessage.when = at;
        node.port.postMessage(allNotesOffMessage);
        rampOutAndDisconnect(at, [outGain], { context: ctx, also: [node] });
      },
    });
  },
};
