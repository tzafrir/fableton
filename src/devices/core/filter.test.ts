import { describe, expect, it } from "vitest";
import type { ParamHandle } from "../../types";
import { Filter, FILTER_TYPES, filterTypeFromIndex } from "./filter";
import {
  fakeServices,
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  fakeOf,
  type FakeBiquadNode,
  type FakeGainNode,
} from "./testing/fakeAudio";

/** A `ParamHandle` stub that just records which fast path got bound. */
function fakeHandle(): {
  handle: ParamHandle;
  boundAudioParam: unknown;
  message: ((v: number, when: number) => void) | undefined;
} {
  const state: {
    boundAudioParam: unknown;
    message: ((v: number, when: number) => void) | undefined;
  } = { boundAudioParam: undefined, message: undefined };
  const handle = {
    bindAudioParam: (param: unknown) => {
      state.boundAudioParam = param;
    },
    bindMessage: (fn: (v: number, when: number) => void) => {
      state.message = fn;
    },
  } as unknown as ParamHandle;
  return { handle, get boundAudioParam() { return state.boundAudioParam; }, get message() { return state.message; } };
}

describe("Filter definition shape", () => {
  it("is a well-formed audioEffect", () => {
    expect(Filter.kind).toBe("audioEffect");
    expect(Filter.audioIn.map((port) => port.id)).toEqual(["in"]);
    expect(Filter.audioOut.map((port) => port.id)).toEqual(["out"]);
    expect(Filter.version).toBeGreaterThanOrEqual(1);
  });

  it("declares the filter proper plus the LFO that makes it an auto-filter", () => {
    expect(Filter.params.map((desc) => desc.id)).toEqual([
      "type",
      "cutoff",
      "resonance",
      "lfoShape",
      "lfoDepth",
      "lfoSync",
      "lfoDiv",
      "lfoRate",
    ]);
  });

  it("the LFO is OFF at defaults, so adding a filter is still just a filter", () => {
    const depth = Filter.params.find((desc) => desc.id === "lfoDepth");
    expect(depth?.defaultValue).toBe(0);
    expect(depth?.unit).toBe("st"); // semitones: it drives `detune`, in cents
  });

  it("cutoff is Hz with a log taper", () => {
    const cutoff = Filter.params.find((desc) => desc.id === "cutoff");
    expect(cutoff?.unit).toBe("Hz");
    expect(cutoff?.taper).toBe("log");
    expect(cutoff?.min).toBeGreaterThan(0);
  });

  it("type is an enum whose labels match FILTER_TYPES", () => {
    const type = Filter.params.find((desc) => desc.id === "type");
    expect(type?.kind).toBe("enum");
    expect(type?.labels).toEqual([...FILTER_TYPES]);
  });

  it("resonance is a plain continuous Q value", () => {
    const resonance = Filter.params.find((desc) => desc.id === "resonance");
    expect(resonance?.kind).toBe("continuous");
    expect(resonance?.min).toBeGreaterThan(0);
  });
});

describe("filterTypeFromIndex", () => {
  it("rounds and clamps into FILTER_TYPES", () => {
    expect(filterTypeFromIndex(0)).toBe("lowpass");
    expect(filterTypeFromIndex(1.4)).toBe("highpass");
    expect(filterTypeFromIndex(-3)).toBe("lowpass");
    expect(filterTypeFromIndex(99)).toBe("notch");
  });
});

describe("Filter.create", () => {
  it("wires io.in -> filter -> gain -> io.out", () => {
    const ctx = createFakeAudioContext();
    const { io, input, output } = buildDeviceIO(ctx);
    Filter.create(asContext(ctx), io, fakeServices());

    expect(input.connectedTo).toHaveLength(1);
    const filterNode = fakeOf(input.connectedTo[0]) as FakeBiquadNode;
    expect(filterNode.nodeType).toBe("biquad");
    expect(filterNode.connectedTo).toHaveLength(1);
    const outGain = fakeOf(filterNode.connectedTo[0]) as FakeGainNode;
    expect(outGain.nodeType).toBe("gain");
    expect(outGain.connectedTo[0]).toBe(fakeOf(output));
  });

  it("binds cutoff and resonance straight to the filter's own AudioParams", () => {
    const ctx = createFakeAudioContext();
    const { io, input } = buildDeviceIO(ctx);
    const instance = Filter.create(asContext(ctx), io, fakeServices());
    const filterNode = fakeOf(input.connectedTo[0]) as FakeBiquadNode;

    const cutoff = fakeHandle();
    instance.connectParam("cutoff", cutoff.handle);
    expect(cutoff.boundAudioParam).toBe(filterNode.frequency);

    const resonance = fakeHandle();
    instance.connectParam("resonance", resonance.handle);
    expect(resonance.boundAudioParam).toBe(filterNode.Q);
  });

  it("binds type to the message path and sets BiquadFilterNode.type on change", () => {
    const ctx = createFakeAudioContext();
    const { io, input } = buildDeviceIO(ctx);
    const instance = Filter.create(asContext(ctx), io, fakeServices());
    const filterNode = fakeOf(input.connectedTo[0]) as FakeBiquadNode;

    expect(filterNode.type).toBe("lowpass");
    const type = fakeHandle();
    instance.connectParam("type", type.handle);
    expect(type.boundAudioParam).toBeUndefined(); // not the AudioParam path
    expect(type.message).toBeTruthy();

    type.message?.(1, 0); // index 1 -> "highpass"
    expect(filterNode.type).toBe("highpass");

    type.message?.(3, 0); // index 3 -> "notch"
    expect(filterNode.type).toBe("notch");
  });

  it("reports zero latency", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = Filter.create(asContext(ctx), io, fakeServices());
    expect(instance.latencySamples?.()).toBe(0);
  });

  it("dispose is idempotent and eventually disconnects the fade-out gain", async () => {
    const ctx = createFakeAudioContext({ currentTime: 0 });
    const { io, input } = buildDeviceIO(ctx);
    const instance = Filter.create(asContext(ctx), io, fakeServices());
    const filterNode = fakeOf(input.connectedTo[0]) as FakeBiquadNode;
    const outGain = fakeOf(filterNode.connectedTo[0]) as FakeGainNode;

    instance.dispose();
    instance.dispose(); // idempotent: second call is a no-op, not a double schedule
    expect(outGain.disconnectCount).toBe(0); // ramp hasn't completed yet

    ctx.currentTime = 0.1; // the audio clock passes the fade
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(outGain.disconnectCount).toBe(1);
    expect(filterNode.disconnectCount).toBe(1);
  });
});
