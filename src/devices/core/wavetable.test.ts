// The main-thread half of `core.wavetable`: what it declares, what it wires,
// and the one thing only it can do — build a wavetable and get it across to
// the render thread.
//
// jsdom has no Web Audio, so `AudioWorkletNode` is stubbed the same way
// ./polySynth.test.ts stubs it: a fake exposing only what `create` touches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamHandle } from "../../types";
import { validateDefinition } from "../harness";
import { WavetableSynth, WAVETABLE_PROCESSOR_NAME } from "./wavetable";
import { AUDIO_PARAM_IDS } from "./wavetable/params";
import { MOD_PARAM_IDS } from "./wavetable/matrix";
import { FRAME_COUNT, WAVETABLES } from "./wavetable/tables";
import {
  fakeServices,
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeAudioWorkletNode,
  FakeGainNode,
} from "./testing/fakeAudio";

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

function lastNode(): StubAudioWorkletNode {
  const node = createdNodes.at(-1);
  if (node === undefined) throw new Error("test setup error: no AudioWorkletNode was constructed");
  return node;
}

/** A handle that records which fast path a param was bound to. */
function recorder(): {
  audio: string[];
  messages: Map<string, (value: number, when: number) => void>;
  handleFor: (id: string) => ParamHandle;
} {
  const audio: string[] = [];
  const messages = new Map<string, (value: number, when: number) => void>();
  return {
    audio,
    messages,
    handleFor: (id: string) =>
      ({
        desc: { id, kind: "enum", min: 0, max: 7, defaultValue: 0 },
        bindAudioParam: () => audio.push(id),
        bindMessage: (write: (value: number, when: number) => void) => messages.set(id, write),
      }) as unknown as ParamHandle,
  };
}

describe("the Wavetable definition", () => {
  it("is a well-formed instrument that brings its own panel", () => {
    expect(() => validateDefinition(WavetableSynth)).not.toThrow();
    expect(WavetableSynth.kind).toBe("instrument");
    expect(WavetableSynth.audioIn).toEqual([]);
    expect(WavetableSynth.audioOut.map((port) => port.id)).toEqual(["out"]);
    expect(WavetableSynth.editor).toBe("wavetable");
  });

  it("declares two oscillators, two filters, three envelopes, two LFOs and a full matrix", () => {
    const ids = new Set(WavetableSynth.params.map((d) => d.id));
    for (const id of ["aTable", "aPos", "aCoarse", "bTable", "bPos", "bPan"]) {
      expect(ids.has(id)).toBe(true);
    }
    for (const id of ["f1Type", "f1Cutoff", "f1Res", "f1Drive", "f1Key", "f2Type", "routing"]) {
      expect(ids.has(id)).toBe(true);
    }
    for (const prefix of ["amp", "env2", "env3"]) {
      for (const stage of ["Attack", "Decay", "Sustain", "Release"]) {
        expect(ids.has(`${prefix}${stage}`)).toBe(true);
      }
    }
    for (const id of MOD_PARAM_IDS.flat()) expect(ids.has(id)).toBe(true);
  });

  it("offers each table by name, in catalogue order", () => {
    const table = WavetableSynth.params.find((d) => d.id === "aTable");
    expect(table?.kind).toBe("enum");
    expect(table?.labels).toEqual(WAVETABLES.map((w) => w.label));
  });
});

describe("Wavetable.prepare", () => {
  it("loads the worklet module", async () => {
    const ctx = createFakeAudioContext();
    await WavetableSynth.prepare?.(asContext(ctx));
    expect(ctx.addedModules).toHaveLength(1);
  });
});

describe("Wavetable.create", () => {
  it("builds the worklet node under the registered name and wires it through an owned gain", () => {
    const ctx = createFakeAudioContext();
    const { io, output } = buildDeviceIO(ctx);
    WavetableSynth.create(asContext(ctx), io, fakeServices());

    expect(createdNodes).toHaveLength(1);
    expect(lastNode().processorName).toBe(WAVETABLE_PROCESSOR_NAME);
    // The device's OWN gain — `buildDeviceIO` has already made one for the
    // port, so "the first gain in the context" is the wrong one.
    const gain = lastNode().connectedTo[0];
    expect(gain).toBeInstanceOf(FakeGainNode);
    expect((gain as FakeGainNode).connectedTo).toContain(output);
  });

  it("asks the worklet for two output channels — the oscillators pan", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    WavetableSynth.create(asContext(ctx), io, fakeServices());
    expect(lastNode().options).toMatchObject({ outputChannelCount: [2] });
  });

  it("binds every param but the two tables to a real AudioParam", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = WavetableSynth.create(asContext(ctx), io, fakeServices());
    const rec = recorder();
    for (const desc of WavetableSynth.params) instance.connectParam?.(desc.id, rec.handleFor(desc.id));

    expect(rec.audio.sort()).toEqual([...AUDIO_PARAM_IDS].sort());
    expect([...rec.messages.keys()].sort()).toEqual(["aTable", "bTable"]);
  });

  it("posts a table's samples once, then only which oscillator is using it", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = WavetableSynth.create(asContext(ctx), io, fakeServices());
    const rec = recorder();
    instance.connectParam?.("aTable", rec.handleFor("aTable"));
    instance.connectParam?.("bTable", rec.handleFor("bTable"));

    const write = (id: string, value: number): void => rec.messages.get(id)?.(value, 0);
    write("aTable", 2);
    const posted = lastNode().posted as Array<{ type: string; index?: number; osc?: number }>;
    expect(posted[0]).toMatchObject({ type: "table", index: 2 });
    expect(posted[1]).toMatchObject({ type: "osc", osc: 0, index: 2 });

    // Osc B on the same table: no second copy of the samples.
    write("bTable", 2);
    expect(posted).toHaveLength(3);
    expect(posted[2]).toMatchObject({ type: "osc", osc: 1, index: 2 });

    // A different table does cross.
    write("bTable", 5);
    expect(posted[3]).toMatchObject({ type: "table", index: 5 });
    expect(posted[4]).toMatchObject({ type: "osc", osc: 1, index: 5 });

    // Re-writing the SAME index says nothing at all. A table param can carry
    // an automation lane, and a lane writes its value every frame — a static
    // one would otherwise post sixty messages a second forever.
    write("bTable", 5);
    write("bTable", 5.4); // rounds to the same table
    expect(posted).toHaveLength(5);
  });

  it("sends a table the worklet can actually read — frames, at every mip level", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = WavetableSynth.create(asContext(ctx), io, fakeServices());
    const rec = recorder();
    instance.connectParam?.("aTable", rec.handleFor("aTable"));
    rec.messages.get("aTable")?.(0, 0);
    const message = (lastNode().posted as Array<{ type: string; data?: { frameCount: number; levels: Float32Array[][] } }>)[0];
    expect(message?.data?.frameCount).toBe(FRAME_COUNT);
    expect(message?.data?.levels[0]).toHaveLength(FRAME_COUNT);
    expect(message?.data?.levels[0]?.[0]?.length).toBeGreaterThan(0);
  });

  it("clamps a table index off the end of the catalogue rather than posting nothing", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = WavetableSynth.create(asContext(ctx), io, fakeServices());
    const rec = recorder();
    instance.connectParam?.("aTable", rec.handleFor("aTable"));
    rec.messages.get("aTable")?.(99, 0);
    expect(lastNode().posted[1]).toMatchObject({ type: "osc", index: WAVETABLES.length - 1 });
  });

  it("forwards notes to the worklet, and panics before it fades on dispose", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = WavetableSynth.create(asContext(ctx), io, fakeServices());
    instance.noteOn?.(64, 100, 0.5);
    instance.noteOff?.(64, 1.5);
    instance.allNotesOff?.(2);
    instance.dispose?.(3);
    const posted = lastNode().posted as Array<{ type: string; pitch?: number; when?: number }>;
    expect(posted[0]).toMatchObject({ type: "noteOn", pitch: 64, vel: 100, when: 0.5 });
    expect(posted[1]).toMatchObject({ type: "noteOff", pitch: 64, when: 1.5 });
    expect(posted[2]).toMatchObject({ type: "allNotesOff", when: 2 });
    expect(posted[3]).toMatchObject({ type: "allNotesOff", when: 3 });
  });

  it("throws a named error if the worklet and the device disagree about a param", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    class MissingParamNode extends StubAudioWorkletNode {
      constructor(c: unknown, name: string, options?: unknown) {
        super(c, name, options);
        (this.parameters as { get: (id: string) => unknown }).get = () => undefined;
      }
    }
    vi.stubGlobal("AudioWorkletNode", MissingParamNode);
    expect(() => WavetableSynth.create(asContext(ctx), io, fakeServices())).toThrow(
      /missing AudioParam/,
    );
  });
});
