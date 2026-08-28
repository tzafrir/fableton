// `WavetableProcessor` driven head-on, the same way
// ./poly-synth-processor.test.ts drives the M0 instrument: the
// AudioWorkletGlobalScope is a realm with four extra globals, so stub the
// four and the class runs in plain Vitest (SS15).
//
// The leaf modules (../devices/core/wavetable/*) already prove the maths.
// What is only true of the composition is tested here: that the params reach
// the DSP they name, that the matrix connects a source to a destination end
// to end, that the routing switch changes what is in series with what, and
// that the voice pool's limit is the polyphony you actually get.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedNoteEvent } from "../devices/core/polySynth/noteEventQueue";
import { MOD_PARAM_IDS } from "../devices/core/wavetable/matrix";
import { WAVETABLE_PARAMS } from "../devices/core/wavetable/params";
import { buildWavetable } from "../devices/core/wavetable/tables";

const SR = 48000;
const BLOCK = 128;

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

async function loadProcessor(): Promise<ProcessorCtor> {
  const module = await import("./wavetable-processor");
  return module.WavetableProcessor as unknown as ProcessorCtor;
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

function send(processor: ProcessorLike, message: unknown): void {
  processor.port.onmessage?.({ data: message });
}

function note(processor: ProcessorLike, event: QueuedNoteEvent): void {
  send(processor, event);
}

/** Every param at its declared default, overridden by `values`. */
function params(values: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const desc of WAVETABLE_PARAMS) out[desc.id] = new Float32Array([desc.defaultValue]);
  for (const [name, value] of Object.entries(values)) out[name] = new Float32Array([value]);
  return out;
}

interface Rendered {
  left: Float32Array;
  right: Float32Array;
}

function render(
  processor: ProcessorLike,
  blocks: number,
  parameters: Record<string, Float32Array>,
  startSeconds = 0,
): Rendered {
  const left = new Float32Array(blocks * BLOCK);
  const right = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    setNow(startSeconds + (b * BLOCK) / SR);
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    processor.process([], [[l, r]], parameters);
    left.set(l, b * BLOCK);
    right.set(r, b * BLOCK);
  }
  return { left, right };
}

function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let max = 0;
  for (let i = from; i < to; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs > max) max = abs;
  }
  return max;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/**
 * How BRIGHT a stretch is: the RMS of its first difference over its own RMS,
 * which is a spectral centroid in two lines.
 *
 * Loudness will not do for this, and the reason is worth stating: a saw's
 * fundamental carries 61% of its energy, so shutting a lowpass down to the
 * fundamental costs only about a fifth of the RMS — and a touch of resonance
 * at the cutoff hands most of that back. A filter test measured in RMS
 * reports that the filter did nothing.
 */
function brightness(samples: Float32Array, from: number, to: number): number {
  let signal = 0;
  let slope = 0;
  for (let i = from + 1; i < to; i++) {
    const v = samples[i]!;
    const d = v - samples[i - 1]!;
    signal += v * v;
    slope += d * d;
  }
  return signal < 1e-12 ? 0 : Math.sqrt(slope / signal);
}

/** Zero crossings, which at a steady pitch is twice the frequency. */
function crossings(samples: Float32Array, from: number, to: number): number {
  let count = 0;
  let previous = samples[from] ?? 0;
  for (let i = from + 1; i < to; i++) {
    const value = samples[i]!;
    if (previous <= 0 && value > 0) count++;
    previous = value;
  }
  return count;
}

/** A processor with both oscillators' tables actually loaded. */
async function rig(): Promise<ProcessorLike> {
  const ctor = await loadProcessor();
  const processor = new ctor();
  for (const index of [0, 1]) {
    send(processor, { type: "table", index, data: buildWavetable(index) });
  }
  send(processor, { type: "osc", osc: 0, index: 0 });
  send(processor, { type: "osc", osc: 1, index: 1 });
  return processor;
}

describe("WavetableProcessor", () => {
  it("registers itself under the name the device constructs", async () => {
    await loadProcessor();
    expect(registered.map(([name]) => name)).toEqual(["core-wavetable"]);
  });

  it("renders exact silence with nothing scheduled", async () => {
    const processor = await rig();
    expect(peak(render(processor, 8, params()).left)).toBe(0);
  });

  it("plays a note, at the pitch it was sent", async () => {
    const processor = await rig();
    note(processor, { type: "noteOn", pitch: 69, vel: 100, when: 0 });
    // Position 0 of Basics is a sine, and no filter at all, so what comes out
    // is the oscillator: 440 Hz, unmistakably.
    const { left } = render(processor, 80, params({ f1On: 0, aPos: 0 }));
    expect(peak(left)).toBeGreaterThan(0.05);
    const from = BLOCK * 8;
    const to = BLOCK * 72;
    const seconds = (to - from) / SR;
    expect(crossings(left, from, to) / seconds).toBeGreaterThan(430);
    expect(crossings(left, from, to) / seconds).toBeLessThan(450);
  });

  it("starts a note on its own sample, not on the block boundary", async () => {
    const processor = await rig();
    const offset = 64;
    note(processor, { type: "noteOn", pitch: 69, vel: 127, when: offset / SR });
    const { left } = render(processor, 1, params({ ampAttack: 0.5 }));
    expect(peak(left, 0, offset)).toBe(0);
    expect(peak(left, offset, BLOCK)).toBeGreaterThan(0);
  });

  it("releases on note-off and eventually goes quiet again", async () => {
    const processor = await rig();
    note(processor, { type: "noteOn", pitch: 60, vel: 110, when: 0 });
    note(processor, { type: "noteOff", pitch: 60, when: 0.02 });
    const p = params({ ampRelease: 20, ampSustain: 60 });
    const { left } = render(processor, 100, p);
    expect(peak(left, 0, BLOCK * 6)).toBeGreaterThan(0.05);
    expect(peak(left, BLOCK * 80)).toBeLessThan(1e-4);
  });

  it("allNotesOff releases every voice rather than cutting it", async () => {
    const processor = await rig();
    for (const pitch of [60, 64, 67]) {
      note(processor, { type: "noteOn", pitch, vel: 100, when: 0 });
    }
    const p = params({ ampRelease: 40 });
    render(processor, 20, p);
    note(processor, { type: "allNotesOff", when: (20 * BLOCK) / SR });
    const { left } = render(processor, 4, p, (20 * BLOCK) / SR);
    // Still audible immediately after the panic — a hard cut would be a click.
    expect(peak(left)).toBeGreaterThan(0.01);
    // ...and gone once the release has run: measured past it, not across it.
    const after = render(processor, 60, p, (24 * BLOCK) / SR).left;
    expect(peak(after, BLOCK * 40)).toBeLessThan(1e-3);
  });

  it("a resonant filter cannot ring on past the note that opened it", async () => {
    // The filters live INSIDE each voice, behind the amp envelope, so a
    // finished voice is exactly zero however hard its filter is still
    // resonating — and the processor can then take its silent fast path
    // rather than grinding four filter sections for nothing.
    const processor = await rig();
    note(processor, { type: "noteOn", pitch: 40, vel: 120, when: 0 });
    note(processor, { type: "noteOff", pitch: 40, when: 0.01 });
    const p = params({ aPos: 100, f1On: 1, f1Res: 100, f1Cutoff: 300, ampRelease: 20 });
    render(processor, 40, p);
    const tail = render(processor, 20, p, (40 * BLOCK) / SR).left;
    expect(peak(tail)).toBe(0);
  });

  it("Voices caps the polyphony: a ninth note steals rather than adds", async () => {
    const processor = await rig();
    const p = params({ voices: 2, f1On: 0, ampSustain: 100, ampDecay: 20 });
    for (const pitch of [48, 55, 62, 69]) {
      note(processor, { type: "noteOn", pitch, vel: 100, when: 0 });
    }
    const four = rms(render(processor, 60, p).left, BLOCK * 30);

    const other = await rig();
    for (const pitch of [62, 69]) {
      note(other, { type: "noteOn", pitch, vel: 100, when: 0 });
    }
    const two = rms(render(other, 60, p).left, BLOCK * 30);
    // Only the last two notes survived the steal, so the two renders match.
    expect(four).toBeCloseTo(two, 3);
  });

  it("Osc B is silent until it is switched on, and then it is heard", async () => {
    const processor = await rig();
    note(processor, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const off = rms(render(processor, 40, params({ f1On: 0, bOn: 0 })).left, BLOCK * 10);

    const both = await rig();
    note(both, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const on = rms(render(both, 40, params({ f1On: 0, bOn: 1 })).left, BLOCK * 10);
    expect(on).toBeGreaterThan(off * 1.2);
  });

  it("pans an oscillator: hard left leaves the right channel empty", async () => {
    const processor = await rig();
    note(processor, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const { left, right } = render(processor, 40, params({ f1On: 0, aPan: -1 }));
    expect(peak(left)).toBeGreaterThan(0.05);
    expect(peak(right)).toBeLessThan(peak(left) / 100);
  });

  it("the filter is in the path: closing it takes the top off", async () => {
    const open = await rig();
    note(open, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const bright = brightness(
      render(open, 40, params({ aPos: 100, f1On: 1, f1Cutoff: 18000 })).left,
      BLOCK * 10,
      BLOCK * 40,
    );

    const shut = await rig();
    note(shut, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const dark = brightness(
      render(shut, 40, params({ aPos: 100, f1On: 1, f1Cutoff: 400 })).left,
      BLOCK * 10,
      BLOCK * 40,
    );
    expect(dark).toBeLessThan(bright / 3);
  });

  it("Serial and Parallel are genuinely different wirings", async () => {
    const shared = { aPos: 100, f1On: 1, f2On: 1, f1Cutoff: 800, f2Type: 2, f2Cutoff: 3000 };
    const serial = await rig();
    note(serial, { type: "noteOn", pitch: 48, vel: 100, when: 0 });
    // A lowpass at 800 then a highpass at 3000 in SERIES is a band nobody is
    // in: almost nothing survives.
    const inSeries = rms(render(serial, 40, params({ ...shared, routing: 0 })).left, BLOCK * 10);

    const parallel = await rig();
    note(parallel, { type: "noteOn", pitch: 48, vel: 100, when: 0 });
    // The same two in PARALLEL sum to nearly the whole spectrum.
    const inParallel = rms(render(parallel, 40, params({ ...shared, routing: 1 })).left, BLOCK * 10);
    expect(inParallel).toBeGreaterThan(inSeries * 5);
  });

  it("Split sends Osc A through Filter 1 and Osc B through Filter 2", async () => {
    // Osc A alone, panned left; Filter 1 shut. In Split, A is the only thing
    // Filter 1 sees, so the left channel dies while the right (Osc B, through
    // an open Filter 2) keeps going.
    const processor = await rig();
    note(processor, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const { left, right } = render(
      processor,
      40,
      params({
        routing: 2,
        aPan: -1,
        bOn: 1,
        bPan: 1,
        bCoarse: 0,
        f1On: 1,
        f1Cutoff: 20,
        f2On: 0,
      }),
    );
    expect(peak(right)).toBeGreaterThan(0.05);
    expect(rms(left, BLOCK * 10)).toBeLessThan(rms(right, BLOCK * 10) / 10);
  });

  it("a matrix cell connects a source to a destination — and zero means zero", async () => {
    const cell = MOD_PARAM_IDS[2]![2]!; // LFO 1 -> Pitch
    expect(cell).toBe("modLfo1Pitch");
    const base = { f1On: 0, lfo1Rate: 8, ampSustain: 100 };

    const still = await rig();
    note(still, { type: "noteOn", pitch: 69, vel: 100, when: 0 });
    const steady = render(still, 60, params({ ...base, [cell]: 0 })).left;

    const wobbling = await rig();
    note(wobbling, { type: "noteOn", pitch: 69, vel: 100, when: 0 });
    const vibrato = render(wobbling, 60, params({ ...base, [cell]: 50 })).left;

    // Same note, same level — but one of them is not at 440 Hz any more.
    const window = [BLOCK * 20, BLOCK * 50] as const;
    const seconds = (window[1] - window[0]) / SR;
    expect(crossings(steady, window[0], window[1]) / seconds).toBeCloseTo(440, -1);
    expect(
      Math.abs(crossings(vibrato, window[0], window[1]) / seconds - 440),
    ).toBeGreaterThan(40);
  });

  it("Env 2 into a cutoff is a filter envelope — the matrix builds one out of parts", async () => {
    const cell = MOD_PARAM_IDS[0]![3]!; // Env 2 -> Cut 1
    expect(cell).toBe("modEnv2Cut1");
    const p = params({
      aPos: 100,
      f1On: 1,
      f1Cutoff: 200,
      env2Attack: 0.5,
      env2Decay: 120,
      env2Sustain: 0,
      ampSustain: 100,
      [cell]: 80,
    });
    const processor = await rig();
    note(processor, { type: "noteOn", pitch: 45, vel: 100, when: 0 });
    const { left } = render(processor, 120, p);
    // Bright at the attack while Env 2 holds the cutoff open, dull once it
    // has decayed back to a 200 Hz lowpass.
    const early = brightness(left, BLOCK * 2, BLOCK * 10);
    const late = brightness(left, BLOCK * 90, BLOCK * 118);
    expect(early).toBeGreaterThan(late * 2);
  });

  it("velocity is always in the amplitude, matrix or no matrix", async () => {
    const soft = await rig();
    note(soft, { type: "noteOn", pitch: 60, vel: 20, when: 0 });
    const quiet = peak(render(soft, 30, params({ f1On: 0 })).left);

    const hard = await rig();
    note(hard, { type: "noteOn", pitch: 60, vel: 127, when: 0 });
    const loud = peak(render(hard, 30, params({ f1On: 0 })).left);
    expect(loud).toBeGreaterThan(quiet * 1.5);
  });

  it("falls back to a sine rather than to silence when no table has arrived", async () => {
    const ctor = await loadProcessor();
    const processor = new ctor();
    note(processor, { type: "noteOn", pitch: 69, vel: 110, when: 0 });
    const { left } = render(processor, 60, params({ f1On: 0 }));
    expect(peak(left)).toBeGreaterThan(0.05);
    const seconds = (BLOCK * 40) / SR;
    expect(crossings(left, BLOCK * 10, BLOCK * 50) / seconds).toBeCloseTo(440, -1);
  });

  it("selecting a table changes the sound", async () => {
    const basics = await rig();
    note(basics, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const sine = rms(render(basics, 40, params({ f1On: 0, aPos: 0 })).left, BLOCK * 10);

    const pulse = await rig();
    send(pulse, { type: "osc", osc: 0, index: 1 }); // Pulse
    note(pulse, { type: "noteOn", pitch: 60, vel: 100, when: 0 });
    const square = rms(render(pulse, 40, params({ f1On: 0, aPos: 0 })).left, BLOCK * 10);
    // A square's RMS is its peak; a sine's is 0.707 of it.
    expect(square).toBeGreaterThan(sine * 1.2);
  });

  it("glide slides into the note instead of jumping to it", async () => {
    const processor = await rig();
    const p = params({ f1On: 0, glide: 300, voices: 1, ampSustain: 100 });
    note(processor, { type: "noteOn", pitch: 48, vel: 100, when: 0 });
    render(processor, 60, p);
    note(processor, { type: "noteOff", pitch: 48, when: (60 * BLOCK) / SR });
    note(processor, { type: "noteOn", pitch: 72, vel: 100, when: (60 * BLOCK) / SR });
    const { left } = render(processor, 20, p, (60 * BLOCK) / SR);
    // 40 ms after the jump the note is on its way up but nowhere near C5
    // (523 Hz); without glide it would already be there.
    const seconds = (BLOCK * 14) / SR;
    const hz = crossings(left, BLOCK * 2, BLOCK * 16) / seconds;
    expect(hz).toBeGreaterThan(140);
    expect(hz).toBeLessThan(420);
  });

  it("stays finite with everything turned up at once", async () => {
    const processor = await rig();
    const p = params({
      aPos: 100,
      bOn: 1,
      bPos: 70,
      routing: 0,
      f1On: 1,
      f1Res: 100,
      f1Drive: 24,
      f2On: 1,
      f2Res: 100,
      f2Type: 1,
      voices: 16,
      gain: 6,
    });
    for (const cell of MOD_PARAM_IDS.flat()) p[cell] = new Float32Array([100]);
    for (let pitch = 36; pitch < 52; pitch++) {
      note(processor, { type: "noteOn", pitch, vel: 127, when: 0 });
    }
    const { left, right } = render(processor, 80, p);
    for (const channel of [left, right]) {
      for (let i = 0; i < channel.length; i++) expect(Number.isFinite(channel[i]!)).toBe(true);
    }
    // Sixteen voices, each held to +/-2 by the output limiter, and +6 dB of
    // device gain over that. Loud and filthy by request — but bounded, which
    // is the claim: a maxed resonant filter fed by a maxed drive cannot
    // produce a spike whose size depends on the patch.
    expect(peak(left)).toBeLessThan(16 * 2 * 2);
  });
});
