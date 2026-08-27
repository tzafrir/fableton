// jsdom has no real Web Audio implementation, so `AudioWorkletNode` is
// stubbed the same way src/engine/context/audioContext.test.ts stubs
// `AudioContext` — a minimal fake exposing only what `PolySynth.create`
// touches (`connect`, `parameters.get`, `port.postMessage`, `disconnect`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamHandle } from "../../types";
import { PolySynth, POLY_SYNTH_PROCESSOR_NAME } from "./polySynth";
import { OSCILLATOR_SHAPES } from "./polySynth/oscillator";
import {
  fakeServices,
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  fakeOf,
  FakeAudioParam,
  FakeAudioWorkletNode,
  FakeGainNode,
} from "./testing/fakeAudio";

/** Every worklet node the stub constructor has built, most recent last. */
let createdNodes: StubAudioWorkletNode[] = [];

class StubAudioWorkletNode extends FakeAudioWorkletNode {
  constructor(_ctx: unknown, name: string, options?: unknown) {
    super(name, options);
    createdNodes.push(this);
  }
}

function fakeHandle(): { handle: ParamHandle; boundAudioParam: unknown } {
  const state: { boundAudioParam: unknown } = { boundAudioParam: undefined };
  const handle = {
    bindAudioParam: (param: unknown) => {
      state.boundAudioParam = param;
    },
    bindMessage: () => {},
  } as unknown as ParamHandle;
  return {
    handle,
    get boundAudioParam() {
      return state.boundAudioParam;
    },
  };
}

beforeEach(() => {
  createdNodes = [];
  vi.stubGlobal("AudioWorkletNode", StubAudioWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastNode(): StubAudioWorkletNode {
  const node = createdNodes.at(-1);
  if (node === undefined) throw new Error("test setup error: no AudioWorkletNode was constructed");
  return node;
}

describe("PolySynth definition shape", () => {
  it("is a well-formed instrument with no audio input", () => {
    expect(PolySynth.kind).toBe("instrument");
    expect(PolySynth.audioIn).toEqual([]);
    expect(PolySynth.audioOut.map((port) => port.id)).toEqual(["out"]);
  });

  it("declares the oscillator, the amp envelope, and ENV 2 for the filter", () => {
    expect(PolySynth.params.map((desc) => desc.id)).toEqual([
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
    ]);
  });

  it("leaves ENV 2 at zero depth, so the synth is unchanged until asked", () => {
    const amount = PolySynth.params.find((desc) => desc.id === "env2Amount");
    expect(amount?.defaultValue).toBe(0);
    expect(amount?.unit).toBe("st"); // semitones: a musically even sweep
  });

  it("shape's labels are exactly the worklet's OSCILLATOR_SHAPES, in order", () => {
    const shape = PolySynth.params.find((desc) => desc.id === "shape");
    expect(shape?.kind).toBe("enum");
    expect(shape?.labels).toEqual([...OSCILLATOR_SHAPES]);
  });

  it("cutoff is Hz with a log taper", () => {
    const cutoff = PolySynth.params.find((desc) => desc.id === "cutoff");
    expect(cutoff?.unit).toBe("Hz");
    expect(cutoff?.taper).toBe("log");
  });
});

describe("PolySynth.prepare", () => {
  it("loads the worklet module exactly once via ctx.audioWorklet.addModule", async () => {
    const ctx = createFakeAudioContext();
    await PolySynth.prepare?.(asContext(ctx));
    expect(ctx.addedModules).toHaveLength(1);
    expect(typeof ctx.addedModules[0]).toBe("string");
  });
});

describe("PolySynth.create", () => {
  it("builds one AudioWorkletNode under the registered processor name and wires it through an owned gain to io.out", () => {
    const ctx = createFakeAudioContext();
    const { io, output } = buildDeviceIO(ctx);

    PolySynth.create(asContext(ctx), io, fakeServices());

    expect(createdNodes).toHaveLength(1);
    const node = lastNode();
    expect(node.processorName).toBe(POLY_SYNTH_PROCESSOR_NAME);
    // node -> owned fade gain -> io.out (SS7 "removal is ... gain-ramped").
    const outGain = fakeOf(node.connectedTo[0]) as FakeGainNode;
    expect(outGain.nodeType).toBe("gain");
    expect(outGain.connectedTo).toEqual([output]);
  });

  it("connects each declared param straight to the worklet's own AudioParam", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = PolySynth.create(asContext(ctx), io, fakeServices());
    const node = lastNode();

    const cutoff = fakeHandle();
    instance.connectParam("cutoff", cutoff.handle);
    expect(cutoff.boundAudioParam).toBeInstanceOf(FakeAudioParam);
    expect(cutoff.boundAudioParam).toBe(node.parameters.get("cutoff"));

    const gain = fakeHandle();
    instance.connectParam("gain", gain.handle);
    expect(gain.boundAudioParam).not.toBe(cutoff.boundAudioParam);
  });

  it("forwards noteOn / noteOff / allNotesOff as port messages with the exact args", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = PolySynth.create(asContext(ctx), io, fakeServices());
    const node = lastNode();

    instance.noteOn?.(60, 100, 1.5);
    instance.noteOff?.(60, 2.0);
    instance.allNotesOff?.(2.5);

    expect(node.posted).toEqual([
      { type: "noteOn", pitch: 60, vel: 100, when: 1.5 },
      { type: "noteOff", pitch: 60, when: 2.0 },
      { type: "allNotesOff", when: 2.5 },
    ]);
  });

  it("reuses one payload object per message type (SS12 zero-allocation)", () => {
    // The scheduler calls these from inside the tick loop, once per note event
    // — a fresh literal each time is hundreds of allocations a second at SS2's
    // budget. `postMessage` structured-clones, so reuse is safe (the same trick
    // src/workers/clock.worker.ts uses for its tick message).
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = PolySynth.create(asContext(ctx), io, fakeServices());
    const node = lastNode();
    const sent: unknown[] = [];
    node.port.postMessage = (message: unknown): void => {
      sent.push(message);
    };

    instance.noteOn?.(60, 100, 1);
    instance.noteOn?.(64, 90, 2);
    instance.noteOff?.(60, 3);
    instance.noteOff?.(64, 4);
    instance.allNotesOff?.(5);
    instance.allNotesOff?.(6);

    expect(sent[0]).toBe(sent[1]); // one noteOn payload...
    expect(sent[2]).toBe(sent[3]); // ...one noteOff payload...
    expect(sent[4]).toBe(sent[5]); // ...one allNotesOff payload
    expect(sent[0]).not.toBe(sent[2]);
    // The LAST send still carries the right values (nothing is stale).
    expect(sent[3]).toEqual({ type: "noteOff", pitch: 64, when: 4 });
  });

  it("reports zero latency", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = PolySynth.create(asContext(ctx), io, fakeServices());
    expect(instance.latencySamples?.()).toBe(0);
  });

  it("dispose sends allNotesOff, fades its own gain, then disconnects", async () => {
    const ctx = createFakeAudioContext({ currentTime: 0 });
    const { io } = buildDeviceIO(ctx);
    const instance = PolySynth.create(asContext(ctx), io, fakeServices());
    const node = lastNode();
    const outGain = fakeOf(node.connectedTo[0]) as FakeGainNode;

    instance.dispose();
    instance.dispose(); // idempotent: no double allNotesOff / double schedule

    expect(node.posted).toEqual([{ type: "allNotesOff", when: 0 }]);
    // The fade runs BEFORE anything is disconnected: the harness disconnects
    // its port nodes at 2x its 20 ms ramp, so the instrument must be silent
    // by then rather than mid-release (SS7 swap semantics).
    expect(outGain.gain.events.map((e) => e.kind)).toEqual(["cancel", "set", "linear"]);
    const ramp = outGain.gain.events.at(-1)!;
    expect(ramp.value).toBe(0);
    expect(ramp.time).toBeCloseTo(0.02, 9);
    expect(node.disconnectCount).toBe(0);

    ctx.currentTime = 0.1; // the audio clock passes the fade
    await new Promise((resolve) => setTimeout(resolve, 120)); // 20 ms ramp + 30 ms slack
    expect(node.disconnectCount).toBe(1);
    expect(outGain.disconnectCount).toBe(1);
  });
});
