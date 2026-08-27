// `CompressorProcessor` end-to-end on the audio thread's own terms — the
// composition its kernel test cannot give us: WHICH input keys the detector.
// The AudioWorkletGlobalScope is just a realm with a few extra globals, so
// stubbing them drives the real class head-on in Vitest (SS15), the same way
// src/worklets/poly-synth-processor.test.ts does.
//
// It lives next to the kernel rather than in src/worklets/ so the compressor's
// whole story — DSP, keying policy, definition — reads in one directory.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  kernel: { reductionDb: number };
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

const params: Record<string, Float32Array> = {
  threshold: Float32Array.of(-20),
  ratio: Float32Array.of(4),
  attack: Float32Array.of(0),
  release: Float32Array.of(0),
  makeup: Float32Array.of(0),
};

async function loadProcessor(): Promise<{
  Processor: new () => ProcessorLike;
  idleSeconds: number;
}> {
  const module = await import("../../../worklets/compressor-processor");
  return {
    Processor: module.CompressorProcessor as unknown as new () => ProcessorLike,
    idleSeconds: module.SC_IDLE_SECONDS,
  };
}

function block(value: number, frames = BLOCK): Float32Array[] {
  return [new Float32Array(frames).fill(value), new Float32Array(frames).fill(value)];
}

/** One render quantum: loud main, `sc` present as the graph always presents
 *  it, carrying whatever `scValue` says. Returns the output's first sample. */
function render(
  processor: ProcessorLike,
  mainValue: number,
  scValue: number | null,
  frames = BLOCK,
): number {
  const main = block(mainValue, frames);
  const out = block(0, frames);
  const inputs = scValue === null ? [main] : [main, block(scValue, frames)];
  processor.process(inputs, [out], params);
  return out[0]?.[0] ?? 0;
}

beforeEach(() => {
  vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
  vi.stubGlobal("sampleRate", SR);
  vi.stubGlobal("currentTime", 0);
  vi.stubGlobal("registerProcessor", () => {});
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CompressorProcessor keying", () => {
  it("compresses when the sc input is CONNECTED BUT SILENT (the default)", async () => {
    // The regression this test exists for: `Compressor.create` always connects
    // the harness's `sc` port node to input 1, so an un-routed compressor sees
    // a present-but-silent input 1. Keying off that made the device inert.
    const { Processor } = await loadProcessor();
    const processor = new Processor();
    const sample = render(processor, 1, 0);
    expect(processor.kernel.reductionDb).toBeCloseTo(15, 1); // 20 dB over, 4:1
    expect(sample).toBeLessThan(0.3);
  });

  it("keys off the sidechain as soon as it carries signal", async () => {
    const { Processor } = await loadProcessor();
    const processor = new Processor();
    // Quiet main (-26 dB, under the -20 threshold), loud key: it must duck.
    render(processor, 0.05, 1);
    expect(processor.kernel.reductionDb).toBeCloseTo(15, 1);
  });

  it("falls back to self-keying after the sidechain goes idle", async () => {
    const { Processor, idleSeconds } = await loadProcessor();
    const processor = new Processor();
    render(processor, 0.05, 1); // key present -> sidechain keying
    const frames = idleSeconds * SR + BLOCK;
    render(processor, 1, 0, frames); // key silent for longer than the timeout
    // A loud main now compresses itself again instead of riding silence.
    expect(processor.kernel.reductionDb).toBeCloseTo(15, 1);
  });

  it("obeys an explicit `scRouted` message over channel counts and silence", async () => {
    const { Processor } = await loadProcessor();
    const processor = new Processor();
    processor.port.onmessage?.({ data: { type: "scRouted", value: true } });
    // Routed, but the key is silent this block: no compression, even though
    // the main input is 20 dB over threshold. That is sidechain ducking.
    render(processor, 1, 0);
    expect(processor.kernel.reductionDb).toBe(0);

    processor.port.onmessage?.({ data: { type: "scRouted", value: false } });
    render(processor, 1, 0);
    expect(processor.kernel.reductionDb).toBeCloseTo(15, 1);
  });

  it("self-keys when input 1 is absent entirely", async () => {
    const { Processor } = await loadProcessor();
    const processor = new Processor();
    render(processor, 1, null);
    expect(processor.kernel.reductionDb).toBeCloseTo(15, 1);
  });
});
