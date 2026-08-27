// jsdom has no real Web Audio implementation, so these tests stub the
// global `AudioContext` constructor with a minimal fake that exposes only
// what `createAudioContext` touches (the constructor options bag). That's
// enough to unit-test the load-bearing logic headless: the
// `latencyHint: "interactive"` default (SS12 guardrail) and the fact that
// the context comes back UNRESUMED — without needing a real browser.
//
// Worklet modules are not loaded here: they belong to the device that owns
// the processor (`core.poly-synth`'s `prepare`, SS7/SS15).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioContext } from "./audioContext";

class FakeAudioContext {
  readonly options: AudioContextOptions | undefined;
  state: AudioContextState = "suspended";
  constructor(options?: AudioContextOptions) {
    this.options = options;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAudioContext", () => {
  it("defaults latencyHint to 'interactive' per the SS12 guardrail", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const context = createAudioContext() as unknown as FakeAudioContext;

    expect(context.options?.latencyHint).toBe("interactive");
  });

  it("forwards an explicit latencyHint instead of the default", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const context = createAudioContext({ latencyHint: "playback" }) as unknown as FakeAudioContext;

    expect(context.options?.latencyHint).toBe("playback");
  });

  it("does not itself attempt to resume the context", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const context = createAudioContext() as unknown as FakeAudioContext;

    expect(context.state).toBe("suspended");
  });
});
