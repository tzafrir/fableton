// `core.limiter` — the kernel head-on (SS15), plus the small main-thread
// wrapper around it.
//
// A limiter makes ONE claim, and it is a claim a listening test cannot
// settle: nothing leaves it above the ceiling. Not on a transient, not on a
// square wave, not on noise, not when you drive 24 dB into it. Most of this
// file is that claim, tested against the signals most likely to break it —
// and the two structural facts it rests on, that the look-ahead really does
// delay the audio and that the gain really does move before the peak rather
// than after it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateDefinition } from "../harness";
import { Limiter, LIMITER_PROCESSOR_NAME } from "./limiter";
import {
  LimiterKernel,
  LOOKAHEAD_MS,
  MovingAverage,
  SlidingMinimum,
  gainOfDb,
  reductionOfGain,
} from "./limiter/kernel";
import {
  fakeServices,
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeAudioWorkletNode,
  FakeGainNode,
} from "./testing/fakeAudio";

const SR = 48000;

const DEFAULTS = {
  gainDb: 0,
  ceilingDb: -0.3,
  releaseMs: 150,
  autoRelease: false,
  link: true,
};

/** Deterministic noise — a seeded LCG, so a failure is reproducible. */
function noise(length: number, amplitude: number, seed = 12345): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

/** Runs a whole signal through in 128-frame blocks, as the worklet does. */
function run(
  kernel: LimiterKernel,
  channels: Float32Array[],
  params: Partial<typeof DEFAULTS> = {},
): Float32Array[] {
  const merged = { ...DEFAULTS, ...params };
  const length = channels[0]?.length ?? 0;
  const out = channels.map((c) => Float32Array.from(c));
  for (let at = 0; at < length; at += 128) {
    const frames = Math.min(128, length - at);
    const block = out.map((c) => c.subarray(at, at + frames));
    kernel.process(block, merged);
  }
  return out;
}

function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let max = 0;
  for (let i = from; i < to; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs > max) max = abs;
  }
  return max;
}

describe("the sliding minimum", () => {
  it("is the minimum of the last `window` values", () => {
    const window = 4;
    const min = new SlidingMinimum(window);
    const input = [5, 3, 8, 9, 2, 7, 7, 7, 6, 1, 4, 4];
    const seen: number[] = [];
    for (let i = 0; i < input.length; i++) {
      seen.push(min.push(input[i]!));
      // ...which is what a brute-force scan over the same window says.
      const from = Math.max(0, i - window + 1);
      expect(seen[i]).toBe(Math.min(...input.slice(from, i + 1)));
    }
  });

  it("holds a low value for exactly the window and no longer", () => {
    const min = new SlidingMinimum(3);
    expect(min.push(1)).toBe(1);
    expect(min.push(0.2)).toBeCloseTo(0.2, 6);
    expect(min.push(1)).toBeCloseTo(0.2, 6);
    expect(min.push(1)).toBeCloseTo(0.2, 6);
    expect(min.push(1)).toBe(1); // the 0.2 has aged out
  });
});

describe("the moving average", () => {
  it("starts at unity, so a limiter that has never worked passes signal", () => {
    expect(new MovingAverage(8).push(1)).toBe(1);
  });

  it("turns a step into a ramp of exactly the window length", () => {
    const average = new MovingAverage(4);
    expect(average.push(0)).toBeCloseTo(0.75, 9);
    expect(average.push(0)).toBeCloseTo(0.5, 9);
    expect(average.push(0)).toBeCloseTo(0.25, 9);
    expect(average.push(0)).toBeCloseTo(0, 9);
  });
});

describe("the ceiling is a ceiling", () => {
  const ceilingDb = -0.3;
  const ceiling = gainOfDb(ceilingDb);
  /** Float slack. The bound is exact in real arithmetic; this is rounding. */
  const slack = 1 + 1e-5;

  const cases: Array<[string, () => Float32Array[], Partial<typeof DEFAULTS>]> = [
    [
      "a full-scale square wave, driven 12 dB past the ceiling",
      () => {
        const n = SR / 2;
        const square = new Float32Array(n);
        for (let i = 0; i < n; i++) square[i] = i % 240 < 120 ? 1 : -1;
        return [square, Float32Array.from(square)];
      },
      { gainDb: 12 },
    ],
    [
      "an impulse train — nothing at all, then everything, one sample wide",
      () => {
        const n = SR / 4;
        const impulses = new Float32Array(n);
        for (let i = 500; i < n; i += 1000) impulses[i] = 1;
        return [impulses, Float32Array.from(impulses)];
      },
      { gainDb: 18 },
    ],
    ["loud noise, uncorrelated between the channels", () => [noise(SR / 4, 0.95, 7), noise(SR / 4, 0.95, 99)], { gainDb: 6 }],
    [
      "a sine sweeping up through the whole band",
      () => {
        const n = SR / 2;
        const sweep = new Float32Array(n);
        let phase = 0;
        for (let i = 0; i < n; i++) {
          phase += (20 + (18000 * i) / n) / SR;
          sweep[i] = Math.sin(2 * Math.PI * phase);
        }
        return [sweep, Float32Array.from(sweep)];
      },
      { gainDb: 9 },
    ],
    [
      "a signal that stops dead — the release cannot let the tail through",
      () => {
        const n = SR / 4;
        const burst = new Float32Array(n);
        for (let i = 0; i < n; i++) burst[i] = i % 6000 < 200 ? Math.sin(i * 0.4) : 0;
        return [burst, Float32Array.from(burst)];
      },
      { gainDb: 24 },
    ],
  ];

  for (const [name, build, params] of cases) {
    it(`holds it against ${name}`, () => {
      const kernel = new LimiterKernel(SR);
      const out = run(kernel, build(), params);
      for (const channel of out) {
        expect(peak(channel)).toBeLessThanOrEqual(ceiling * slack);
      }
      // ...and did not simply mute everything to get there.
      expect(peak(out[0]!)).toBeGreaterThan(ceiling * 0.5);
    });
  }

  it("holds every ceiling it is offered, not just the default one", () => {
    for (const db of [-24, -12, -6, -1, 0]) {
      const kernel = new LimiterKernel(SR);
      const out = run(kernel, [noise(SR / 8, 0.9, 3), noise(SR / 8, 0.9, 4)], {
        ceilingDb: db,
        gainDb: 12,
      });
      expect(peak(out[0]!)).toBeLessThanOrEqual(gainOfDb(db) * slack);
    }
  });
});

describe("look-ahead is what makes it a limiter and not a fast compressor", () => {
  it("delays the audio by exactly the look-ahead", () => {
    const kernel = new LimiterKernel(SR);
    const delay = kernel.lookaheadSamples;
    expect(delay).toBe(Math.round((LOOKAHEAD_MS / 1000) * SR));

    const input = new Float32Array(1024);
    input[600] = 0.5; // well under the ceiling: nothing should touch it
    const out = run(kernel, [input, Float32Array.from(input)]);
    expect(out[0]![600 + delay]).toBeCloseTo(0.5, 6);
    expect(peak(out[0]!, 0, 600 + delay)).toBe(0);
  });

  it("has the gain already down when the peak arrives, so nothing is clipped", () => {
    // The tell: a limiter that reacts LATE truncates the front of the peak —
    // the first samples come through at full height and the rest is squashed,
    // which is clipping with extra steps. Anticipating means the whole peak
    // comes through scaled by one smooth gain instead.
    const kernel = new LimiterKernel(SR);
    const n = 4096;
    const input = new Float32Array(n);
    for (let i = 2000; i < 2100; i++) input[i] = 1; // a 2 ms full-scale slab
    const out = run(kernel, [input, Float32Array.from(input)]);

    const delay = kernel.lookaheadSamples;
    const slab = Array.from(out[0]!.subarray(2000 + delay, 2100 + delay));
    const ceiling = gainOfDb(-0.3);
    for (const value of slab) expect(value).toBeLessThanOrEqual(ceiling * (1 + 1e-5));
    // Flat: every sample of the slab was scaled by the same gain, to within a
    // fraction of a dB. A late reactor's first sample would be 1.0 and its
    // last would be far lower.
    expect(Math.min(...slab)).toBeGreaterThan(Math.max(...slab) * 0.97);
  });

  it("moves the gain smoothly: no step big enough to be a click", () => {
    const kernel = new LimiterKernel(SR);
    const n = 8192;
    const input = new Float32Array(n);
    // Silence, then full scale, instantly — the hardest thing to ease into.
    for (let i = 4000; i < n; i++) input[i] = Math.sin(i * 0.05);
    const out = run(kernel, [input, Float32Array.from(input)], { gainDb: 18 });
    // The gain the limiter applied, sample by sample, reconstructed from the
    // delayed input — and it never jumps. Measured PER SAMPLE, because the
    // readings either side of a zero crossing are several samples apart (the
    // gain is unobservable there, the signal being ~0).
    const delay = kernel.lookaheadSamples;
    let biggestStep = 0;
    let previous = Number.NaN;
    let previousAt = 0;
    for (let i = 3900 + delay; i < n - 1; i++) {
      const driven = input[i - delay]! * gainOfDb(18);
      if (Math.abs(driven) < 0.05) continue;
      const gain = out[0]![i]! / driven;
      if (Number.isFinite(previous)) {
        biggestStep = Math.max(biggestStep, Math.abs(gain - previous) / (i - previousAt));
      }
      previous = gain;
      previousAt = i;
    }
    expect(biggestStep).toBeLessThan(0.02);
  });
});

describe("the controls", () => {
  it("passes anything under the ceiling through untouched", () => {
    const kernel = new LimiterKernel(SR);
    const input = new Float32Array(2048);
    for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin(i * 0.07);
    const out = run(kernel, [input, Float32Array.from(input)]);
    const delay = kernel.lookaheadSamples;
    for (let i = delay; i < input.length; i++) {
      expect(out[0]![i]!).toBeCloseTo(input[i - delay]!, 6);
    }
    expect(kernel.peakReductionDb).toBe(0);
  });

  it("Gain drives the material into the ceiling — that is what it is for", () => {
    const quiet = new Float32Array(SR / 8);
    for (let i = 0; i < quiet.length; i++) quiet[i] = 0.25 * Math.sin(i * 0.05); // -12 dBFS

    const asIs = run(new LimiterKernel(SR), [quiet, Float32Array.from(quiet)]);
    expect(peak(asIs[0]!)).toBeCloseTo(0.25, 2);

    const driven = run(new LimiterKernel(SR), [quiet, Float32Array.from(quiet)], { gainDb: 24 });
    expect(peak(driven[0]!)).toBeCloseTo(gainOfDb(-0.3), 2);
  });

  it("Release is how fast the gain comes back", () => {
    /** Gain still being applied 60 ms after one loud hit. */
    const gainAfterHit = (releaseMs: number): number => {
      const kernel = new LimiterKernel(SR);
      const n = SR / 4;
      const input = new Float32Array(n);
      for (let i = 1000; i < 1300; i++) input[i] = 1;
      // A quiet tone afterwards, so there IS something to measure the gain on.
      for (let i = 1400; i < n; i++) input[i] = 0.05 * Math.sin(i * 0.05);
      const out = run(kernel, [input, Float32Array.from(input)], { releaseMs, gainDb: 12 });
      const at = 1300 + kernel.lookaheadSamples + Math.round(0.06 * SR);
      let sum = 0;
      for (let i = at; i < at + 400; i++) sum += Math.abs(out[0]![i]!);
      let reference = 0;
      for (let i = at; i < at + 400; i++) reference += Math.abs(input[i - kernel.lookaheadSamples]! * gainOfDb(12));
      return sum / reference;
    };
    // A fast release is most of the way back; a slow one is still holding on.
    expect(gainAfterHit(10)).toBeGreaterThan(0.9);
    expect(gainAfterHit(1000)).toBeLessThan(0.5);
    expect(gainAfterHit(10)).toBeGreaterThan(gainAfterHit(1000));
  });

  it("Link decides whether one channel's peak pulls the other down", () => {
    const n = SR / 8;
    const loudLeft = new Float32Array(n);
    const quietRight = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      loudLeft[i] = Math.sin(i * 0.05);
      quietRight[i] = 0.2 * Math.sin(i * 0.05);
    }

    const linked = run(new LimiterKernel(SR), [Float32Array.from(loudLeft), Float32Array.from(quietRight)], {
      gainDb: 12,
      link: true,
    });
    const split = run(new LimiterKernel(SR), [Float32Array.from(loudLeft), Float32Array.from(quietRight)], {
      gainDb: 12,
      link: false,
    });

    // Unlinked, the quiet channel is 12 dB up and untouched. Linked, it is
    // ducked along with its partner — which is what keeps the image still.
    expect(peak(split[1]!)).toBeGreaterThan(peak(linked[1]!) * 1.5);
    // Both still hold the ceiling on the loud channel.
    for (const out of [linked, split]) {
      expect(peak(out[0]!)).toBeLessThanOrEqual(gainOfDb(-0.3) * (1 + 1e-5));
    }
  });

  it("Auto lets the release follow the material instead of the knob", () => {
    /** Reduction still held 40 ms after a sustained loud passage ends. */
    const heldAfter = (autoRelease: boolean): number => {
      const kernel = new LimiterKernel(SR);
      const n = SR;
      const input = new Float32Array(n);
      // Half a second of sustained loudness — long enough for auto-release to
      // decide this is a passage — then a quiet tail to measure the gain on.
      for (let i = 0; i < n; i++) {
        input[i] = i < SR / 2 ? Math.sin(i * 0.05) : 0.05 * Math.sin(i * 0.05);
      }
      const out = run(kernel, [input, Float32Array.from(input)], {
        gainDb: 18,
        releaseMs: 150,
        autoRelease,
      });
      const at = SR / 2 + kernel.lookaheadSamples + Math.round(0.04 * SR);
      let sum = 0;
      let reference = 0;
      for (let i = at; i < at + 400; i++) {
        sum += Math.abs(out[0]![i]!);
        reference += Math.abs(input[i - kernel.lookaheadSamples]! * gainOfDb(18));
      }
      return sum / reference;
    };
    // After a long loud passage, auto-release is still holding the gain down
    // where the fixed 150 ms has already let go — which is the difference
    // between a limiter that breathes and one that pumps.
    expect(heldAfter(true)).toBeLessThan(heldAfter(false));
  });

  it("meters the PEAK reduction of a block, not the last sample's", () => {
    const kernel = new LimiterKernel(SR);
    const block = [new Float32Array(128), new Float32Array(128)];
    // One transient early in the block, silence after it: by the last sample
    // the gain is on its way back, so an instantaneous reading understates it.
    for (let i = 4; i < 12; i++) {
      block[0]![i] = 1;
      block[1]![i] = 1;
    }
    kernel.process(block, { ...DEFAULTS, gainDb: 18 });
    expect(kernel.peakReductionDb).toBeGreaterThan(12);
    expect(kernel.peakReductionDb).toBeGreaterThanOrEqual(kernel.reductionDb);
  });

  it("reports no reduction when it is not reducing", () => {
    expect(reductionOfGain(1)).toBe(0);
    expect(reductionOfGain(1.5)).toBe(0);
    expect(reductionOfGain(0.5)).toBeCloseTo(6.02, 1);
  });

  it("stays finite on a signal of pure zeroes and on one of pure ones", () => {
    for (const value of [0, 1, -1]) {
      const kernel = new LimiterKernel(SR);
      const channel = new Float32Array(2048).fill(value);
      const out = run(kernel, [channel, Float32Array.from(channel)], { gainDb: 24 });
      for (let i = 0; i < out[0]!.length; i++) expect(Number.isFinite(out[0]![i]!)).toBe(true);
    }
  });
});

// --- the main-thread wrapper ------------------------------------------------

let createdNodes: StubAudioWorkletNode[] = [];

class StubAudioWorkletNode extends FakeAudioWorkletNode {
  constructor(_ctx: unknown, name: string, options?: unknown) {
    super(name, options);
    createdNodes.push(this);
  }
}

beforeEach(() => {
  createdNodes = [];
  vi.stubGlobal("AudioWorkletNode", StubAudioWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Limiter definition", () => {
  it("is a well-formed effect with no sidechain to claim", () => {
    expect(() => validateDefinition(Limiter)).not.toThrow();
    expect(Limiter.kind).toBe("audioEffect");
    expect(Limiter.audioIn.map((port) => port.id)).toEqual(["in"]);
    expect(Limiter.audioOut.map((port) => port.id)).toEqual(["out"]);
  });

  it("declares the five controls and the one readout", () => {
    expect(Limiter.params.map((d) => d.id)).toEqual([
      "gain",
      "ceiling",
      "release",
      "autoRelease",
      "link",
    ]);
    expect(Limiter.readouts?.map((r) => r.id)).toEqual(["reduction"]);
  });

  it("defaults its ceiling below full scale, where an encoder cannot overshoot it", () => {
    const ceiling = Limiter.params.find((d) => d.id === "ceiling");
    expect(ceiling?.defaultValue).toBe(-0.3);
    expect(ceiling?.max).toBe(0);
    // Not a fader-sized range, so the bottom reads as a number rather than
    // as "-inf dB" — a ceiling of -24 dB means quiet, not silent.
    expect(ceiling?.toText(-24)).toBe("-24.0 dB");
  });

  it("names the Link toggle's positions rather than saying On and Off", () => {
    const link = Limiter.params.find((d) => d.id === "link");
    expect(link?.label).toBe("Stereo Link");
    expect(link?.toText(1)).toBe("Linked");
    expect(link?.toText(0)).toBe("L/R");
    expect(link?.defaultValue).toBe(1);
  });

  it("leaves Auto off, so the Release knob means what it says", () => {
    expect(Limiter.params.find((d) => d.id === "autoRelease")?.defaultValue).toBe(0);
  });

  it("takes the ceiling instantly — a de-zippered ceiling is an overshoot", () => {
    // The 15 ms default ramp would have a freshly loaded project honour the
    // worklet's own default ceiling for its first fifteen milliseconds and
    // glide to the document's, which is an overshoot at the top of every
    // render. Safe to set instantly because a ceiling is not a gain: it
    // changes what the detector asks for, and the look-ahead still eases the
    // gain across the whole window.
    expect(Limiter.params.find((d) => d.id === "ceiling")?.smoothingMs).toBe(0);
  });
});

describe("Limiter.create", () => {
  it("wires the worklet between the in port and an owned output gain", async () => {
    const ctx = createFakeAudioContext();
    await Limiter.prepare?.(asContext(ctx));
    expect(ctx.addedModules).toHaveLength(1);

    const { io, input, output } = buildDeviceIO(ctx);
    Limiter.create(asContext(ctx), io, fakeServices());
    const node = createdNodes.at(-1)!;
    expect(node.processorName).toBe(LIMITER_PROCESSOR_NAME);
    expect(input.connectedTo).toContain(node);
    const gain = node.connectedTo[0];
    expect(gain).toBeInstanceOf(FakeGainNode);
    expect((gain as FakeGainNode).connectedTo).toContain(output);
  });

  it("binds all five params to real AudioParams", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = Limiter.create(asContext(ctx), io, fakeServices());
    const bound: string[] = [];
    for (const desc of Limiter.params) {
      instance.connectParam?.(desc.id, {
        desc,
        bindAudioParam: () => bound.push(desc.id),
        bindMessage: () => undefined,
      } as never);
    }
    expect(bound).toEqual(["gain", "ceiling", "release", "autoRelease", "link"]);
  });

  it("reports the look-ahead as latency, so PDC has a number when it lands", () => {
    const ctx = createFakeAudioContext({ sampleRate: 48000 });
    const { io } = buildDeviceIO(ctx);
    const instance = Limiter.create(asContext(ctx), io, fakeServices());
    expect(instance.latencySamples?.()).toBe(144); // 3 ms at 48 kHz
  });

  it("publishes the worklet's gain reduction as the GR readout", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = Limiter.create(asContext(ctx), io, fakeServices());
    const node = createdNodes.at(-1)!;
    expect(instance.readValue?.("reduction")).toBe(0);
    node.port.onmessage?.({ data: { type: "gr", value: 7.5 } });
    expect(instance.readValue?.("reduction")).toBe(7.5);
    // Anything else on the port is ignored rather than trusted.
    node.port.onmessage?.({ data: { type: "gr", value: Number.NaN } });
    node.port.onmessage?.({ data: "nonsense" });
    expect(instance.readValue?.("reduction")).toBe(7.5);
    expect(instance.readValue?.("nothing")).toBeUndefined();
  });
});
