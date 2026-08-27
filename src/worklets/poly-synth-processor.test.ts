// The composition test the leaf modules cannot give us (§15: "no browser
// needed for any of the load-bearing logic"). `PolySynthProcessor` is the
// M0 instrument's real audio-thread logic — per-block dispatch of due note
// events, voice allocation -> envelope wiring, velocity scaling, the sample
// loop — and it runs in the AudioWorkletGlobalScope, which is just a realm
// with four extra globals. Stub those four and the class drives head-on in
// plain Vitest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolySynth } from "../devices/core/polySynth";
import type { QueuedNoteEvent } from "../devices/core/polySynth/noteEventQueue";

const SR = 48000;
const BLOCK = 128;

/** Stand-in for the `AudioWorkletProcessor` base class. */
class FakeProcessorBase {
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(): void {},
  };
}

interface ProcessorLike {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

type ProcessorCtor = new () => ProcessorLike;

let registered: Array<[string, unknown]> = [];

function setNow(seconds: number): void {
  vi.stubGlobal("currentTime", seconds);
}

async function loadProcessor(): Promise<{
  ctor: ProcessorCtor;
  descriptors: Array<{ name: string; minValue?: number; maxValue?: number; defaultValue?: number }>;
}> {
  const module = await import("./poly-synth-processor");
  const ctor = module.PolySynthProcessor as unknown as ProcessorCtor;
  return {
    ctor,
    descriptors: module.PolySynthProcessor.parameterDescriptors,
  };
}

beforeEach(() => {
  registered = [];
  vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
  vi.stubGlobal("sampleRate", SR);
  vi.stubGlobal("currentTime", 0);
  vi.stubGlobal("registerProcessor", (name: string, ctor: unknown) => {
    registered.push([name, ctor]);
  });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function push(processor: ProcessorLike, event: QueuedNoteEvent): void {
  processor.port.onmessage?.({ data: event });
}

/** k-rate parameter block: one value for the whole quantum. */
function params(values: Record<string, number>): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const [name, value] of Object.entries(values)) out[name] = new Float32Array([value]);
  return out;
}

/** Renders `blocks` render quanta from `startSeconds`, returning channel 0. */
function render(
  processor: ProcessorLike,
  blocks: number,
  startSeconds = 0,
  parameters: Record<string, Float32Array> = {},
): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    setNow(startSeconds + (b * BLOCK) / SR);
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    processor.process([], [[left, right]], parameters);
    out.set(left, b * BLOCK);
  }
  return out;
}

/** Largest absolute difference between consecutive samples. */
function maxStep(samples: Float32Array, from = 1, to = samples.length): number {
  let max = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    const delta = Math.abs(samples[i]! - samples[i - 1]!);
    if (delta > max) max = delta;
  }
  return max;
}

function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let max = 0;
  for (let i = from; i < to; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs > max) max = abs;
  }
  return max;
}

describe("PolySynthProcessor", () => {
  it("registers itself under the name the device definition constructs", async () => {
    await loadProcessor();
    expect(registered.map(([name]) => name)).toEqual(["core-poly-synth"]);
  });

  it("renders silence with nothing scheduled", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    expect(peak(render(processor, 4))).toBe(0);
  });

  it("plays a scheduled note and releases it on note-off", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    push(processor, { type: "noteOn", pitch: 69, vel: 100, when: 0 });
    push(processor, { type: "noteOff", pitch: 69, when: 0.05 });
    const samples = render(processor, 40); // ~107 ms
    expect(peak(samples)).toBeGreaterThan(0.1);
  });

  it("starts a note on its own sample, not on the block boundary (§12)", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    const offset = 64;
    push(processor, { type: "noteOn", pitch: 69, vel: 127, when: offset / SR });
    const samples = render(processor, 1);
    expect(peak(samples, 0, offset)).toBe(0); // nothing before its timestamp
    expect(peak(samples, offset, BLOCK)).toBeGreaterThan(0);
  });

  it("a note shorter than one render quantum still sounds", async () => {
    // noteOn and noteOff inside ONE 128-sample block: applying both at the
    // block boundary would collapse the note to zero length and drop it.
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    push(processor, { type: "noteOn", pitch: 69, vel: 127, when: 10 / SR });
    push(processor, { type: "noteOff", pitch: 69, when: 34 / SR });
    const samples = render(processor, 40);
    expect(peak(samples)).toBeGreaterThan(0);
    expect(peak(samples, 0, 10)).toBe(0);
  });

  it("allNotesOff silences notes the look-ahead already queued (§12 stop)", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    // 200 ms of look-ahead handed the worklet a note that has not attacked yet...
    push(processor, { type: "noteOn", pitch: 69, vel: 127, when: 0.1 });
    push(processor, { type: "noteOff", pitch: 69, when: 0.4 });
    // ...and then the user pressed Stop.
    push(processor, { type: "allNotesOff", when: 0.02 });
    const samples = render(processor, 80); // ~213 ms, well past the note's onset
    expect(peak(samples)).toBe(0);
  });

  it("allNotesOff releases a note that is already sounding", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    push(processor, { type: "noteOn", pitch: 69, vel: 127, when: 0 });
    push(processor, { type: "allNotesOff", when: 0.01 });
    const early = render(processor, 8); // 0 .. ~21 ms
    expect(peak(early)).toBeGreaterThan(0);
    // Default release is 250 ms, counted in rendered samples from the panic.
    const rest = render(processor, 160, (8 * BLOCK) / SR); // ~427 ms more
    expect(peak(rest, rest.length - 20 * BLOCK)).toBe(0);
  });

  it("sounds several pitches at once", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    push(processor, { type: "noteOn", pitch: 60, vel: 127, when: 0 });
    const single = peak(render(processor, 20));
    const chordProcessor = new ctor();
    push(chordProcessor, { type: "noteOn", pitch: 60, vel: 127, when: 0 });
    push(chordProcessor, { type: "noteOn", pitch: 64, vel: 127, when: 0 });
    push(chordProcessor, { type: "noteOn", pitch: 67, vel: 127, when: 0 });
    expect(peak(render(chordProcessor, 20))).toBeGreaterThan(single);
  });

  it("scales amplitude by velocity", async () => {
    const { ctor } = await loadProcessor();
    const loud = new ctor();
    push(loud, { type: "noteOn", pitch: 69, vel: 127, when: 0 });
    const soft = new ctor();
    push(soft, { type: "noteOn", pitch: 69, vel: 32, when: 0 });
    expect(peak(render(soft, 20))).toBeLessThan(peak(render(loud, 20)) / 2);
  });

  it("is silent at the bottom of the gain range, exactly as `toText` reads (§4)", async () => {
    // `p.db("gain", { min: -60 })` makes `desc.toText(-60)` say "-inf dB", and
    // §4 makes that readout the sanctioned view of the real value — so -60 dB
    // has to be silence here, not 0.001x (which is audible).
    const { ctor } = await loadProcessor();
    const silent = new ctor();
    push(silent, { type: "noteOn", pitch: 69, vel: 127, when: 0 });
    expect(peak(render(silent, 20, 0, params({ gain: -60 })))).toBe(0);

    const audible = new ctor();
    push(audible, { type: "noteOn", pitch: 69, vel: 127, when: 0 });
    expect(peak(render(audible, 20, 0, params({ gain: -59 })))).toBeGreaterThan(0);
  });

  it("ramps velocity when a sounding voice is retriggered (§7 click-free)", async () => {
    // The envelope deliberately does NOT reset on retrigger/steal (envelope.ts)
    // so the amplitude stays continuous; an instantaneous velocity write would
    // undo exactly that and step the sample value — a click on the audio
    // thread. Measure the biggest single-sample jump around the retrigger.
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    push(processor, { type: "noteOn", pitch: 69, vel: 127, when: 0 });
    const sustaining = render(processor, 40); // settle onto the sustain stage
    const settledDelta = maxStep(sustaining, sustaining.length - 4 * BLOCK);

    // Scheduled a few blocks INTO the next render, so the retrigger sample and
    // its neighbours all land inside one measured buffer.
    const from = (40 * BLOCK) / SR;
    push(processor, { type: "noteOn", pitch: 69, vel: 8, when: (44 * BLOCK) / SR });
    const retriggered = render(processor, 8, from);
    // Same order of magnitude as ordinary oscillator motion, not the ~16x
    // amplitude collapse an unramped velocity write would produce.
    expect(maxStep(retriggered)).toBeLessThan(settledDelta * 3);
  });

  it("keeps its AudioParam ranges identical to the device descriptors (§4)", async () => {
    // The worklet's `parameterDescriptors` and `PolySynth.params` describe the
    // same knobs across a postMessage boundary; the registry owns the one
    // range truth (§4), so a widened descriptor must not be silently clamped
    // by a stale `AudioParam` min/max.
    const { descriptors } = await loadProcessor();
    for (const descriptor of descriptors) {
      const param = PolySynth.params.find((desc) => desc.id === descriptor.name);
      expect(param, `no descriptor for worklet param "${descriptor.name}"`).toBeDefined();
      expect([descriptor.name, descriptor.minValue]).toEqual([descriptor.name, param!.min]);
      expect([descriptor.name, descriptor.maxValue]).toEqual([descriptor.name, param!.max]);
      expect([descriptor.name, descriptor.defaultValue]).toEqual([
        descriptor.name,
        param!.defaultValue,
      ]);
    }
    // Every audio-rate-bound device param has a worklet counterpart.
    const worklet = new Set(descriptors.map((d) => d.name));
    for (const param of PolySynth.params) expect(worklet.has(param.id)).toBe(true);
  });
});

describe("ENV 2 — the filter envelope", () => {
  // Brightness, measured as the STEEPEST edge in a window. A lowpass rounds
  // a square wave's edges, so this falls as the filter closes — and unlike
  // an average it is not swamped by which part of the cycle a window happens
  // to catch.
  const edge = (samples: Float32Array, from: number, to: number): number =>
    maxStep(samples, from, to);

  const base = {
    shape: 1, // square: plenty of harmonics for the filter to remove
    cutoff: 300,
    attack: 1,
    decay: 4000,
    sustain: 100,
    release: 1,
    gain: 0,
    env2Attack: 1,
    // Short enough to complete inside the ~50 ms these tests render.
    env2Decay: 30,
    env2Sustain: 0,
    env2Release: 1,
  };

  it("opens the filter on a note, then closes it as the envelope decays", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    push(processor, { type: "noteOn", pitch: 45, vel: 127, when: 0 });
    // +36 semitones of sweep from 300 Hz: bright at the attack, dark once
    // ENV 2 has decayed to its zero sustain.
    const rendered = render(processor, 20, 0, params({ ...base, env2Amount: 36 }));

    const early = edge(rendered, BLOCK, BLOCK * 4);
    const late = edge(rendered, rendered.length - BLOCK * 4, rendered.length);
    expect(early).toBeGreaterThan(late * 3);
  });

  it("does nothing at zero amount — the synth is unchanged until asked", async () => {
    const { ctor } = await loadProcessor();
    const withEnv = new ctor();
    const without = new ctor();
    push(withEnv, { type: "noteOn", pitch: 45, vel: 127, when: 0 });
    push(without, { type: "noteOn", pitch: 45, vel: 127, when: 0 });
    const a = render(withEnv, 8, 0, params({ ...base, env2Amount: 0 }));
    const b = render(without, 8, 0, params({ ...base, env2Amount: 0, env2Decay: 500 }));
    // Identical output whatever the other ENV 2 settings say: amount 0 is off.
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("holds the filter open until the LAST note of a chord is released", async () => {
    const { ctor } = await loadProcessor();
    const processor = new ctor();
    const settings = params({ ...base, env2Amount: 36, env2Sustain: 100 });
    push(processor, { type: "noteOn", pitch: 45, vel: 127, when: 0 });
    push(processor, { type: "noteOn", pitch: 52, vel: 127, when: 0 });
    render(processor, 4, 0, settings);

    // One note released. A shared envelope gated by "any note" would start
    // closing here, and a chord's filter would snap shut as its first note
    // let go.
    push(processor, { type: "noteOff", pitch: 45, when: 4 * (BLOCK / SR) });
    const held = render(processor, 8, 4 * (BLOCK / SR), settings);
    const openEdge = edge(held, BLOCK, held.length);

    push(processor, { type: "noteOff", pitch: 52, when: 12 * (BLOCK / SR) });
    const closed = render(processor, 12, 12 * (BLOCK / SR), settings);
    expect(edge(closed, closed.length - BLOCK * 4, closed.length)).toBeLessThan(openEdge / 2);
  });
});
