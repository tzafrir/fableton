// `core.noise` — the playable noise source. Headless, against the fake
// context (SS15: the load-bearing logic needs no browser).

import { describe, expect, it } from "vitest";
import type { DeviceInstance, ParamHandle } from "../../types";
import { validateDefinition } from "../harness";
import {
  KEY_TRACK_CENTER_PITCH,
  MAX_VOICES,
  NOISE_COLORS,
  Noise,
  noiseBufferOf,
  noiseColorFromIndex,
  noiseFilterFromIndex,
  trackedCutoffHz,
} from "./noise";
import {
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeBiquadNode,
  FakeBufferSourceNode,
  fakeServices,
  type FakeAudioContext,
} from "./testing/fakeAudio";

function rig(): { ctx: FakeAudioContext; instance: DeviceInstance } {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  return { ctx, instance: Noise.create(asContext(ctx), io, fakeServices()) };
}

function paramPusher(instance: DeviceInstance) {
  const writers = new Map<string, (value: number, when: number) => void>();
  return {
    bind(localId: string): void {
      const handle = {
        bindMessage: (write: (value: number, when: number) => void) => {
          writers.set(localId, write);
        },
        bindAudioParam: () => undefined,
      } as unknown as ParamHandle;
      instance.connectParam?.(localId, handle);
    },
    push(localId: string, value: number): void {
      writers.get(localId)?.(value, 0);
    },
  };
}

const sources = (ctx: FakeAudioContext): FakeBufferSourceNode[] =>
  ctx.created.filter((n): n is FakeBufferSourceNode => n instanceof FakeBufferSourceNode);
const filters = (ctx: FakeAudioContext): FakeBiquadNode[] =>
  ctx.created.filter((n): n is FakeBiquadNode => n instanceof FakeBiquadNode);

describe("the definition", () => {
  it("passes the harness's own validator", () => {
    expect(() => validateDefinition(Noise)).not.toThrow();
  });

  it("declares no audio input: it is a source, not an effect", () => {
    expect(Noise.kind).toBe("instrument");
    expect(Noise.audioIn).toEqual([]);
  });
});

describe("key tracking (the device's one musical claim)", () => {
  it("does not move the cutoff at 0% — every note is the same noise", () => {
    expect(trackedCutoffHz(4000, 36, 0)).toBe(4000);
    expect(trackedCutoffHz(4000, 96, 0)).toBe(4000);
  });

  it("tracks the keyboard exactly at 100%: an octave up doubles the cutoff", () => {
    expect(trackedCutoffHz(1000, KEY_TRACK_CENTER_PITCH, 1)).toBeCloseTo(1000, 6);
    expect(trackedCutoffHz(1000, KEY_TRACK_CENTER_PITCH + 12, 1)).toBeCloseTo(2000, 6);
    expect(trackedCutoffHz(1000, KEY_TRACK_CENTER_PITCH - 12, 1)).toBeCloseTo(500, 6);
  });

  it("scales in between, and never leaves the audible band", () => {
    expect(trackedCutoffHz(1000, KEY_TRACK_CENTER_PITCH + 12, 0.5)).toBeCloseTo(1000 * 2 ** 0.5, 6);
    expect(trackedCutoffHz(1000, 127, 1)).toBeLessThanOrEqual(20000);
    expect(trackedCutoffHz(1000, 0, 1)).toBeGreaterThanOrEqual(20);
  });
});

describe("the noise buffers", () => {
  it("makes one buffer per (context, colour) and shares it", () => {
    const ctx = asContext(createFakeAudioContext());
    for (const color of NOISE_COLORS) {
      expect(noiseBufferOf(ctx, color)).toBe(noiseBufferOf(ctx, color));
    }
    expect(noiseBufferOf(ctx, "white")).not.toBe(noiseBufferOf(ctx, "pink"));
  });

  it("is deterministic, so an offline render is reproducible (SS16)", () => {
    const a = noiseBufferOf(asContext(createFakeAudioContext()), "white").getChannelData(0);
    const b = noiseBufferOf(asContext(createFakeAudioContext()), "white").getChannelData(0);
    expect(Array.from(a.slice(0, 32))).toEqual(Array.from(b.slice(0, 32)));
  });

  it("actually darkens with colour: white is the busiest, brown the smoothest", () => {
    // Mean absolute difference between neighbouring samples is a crude but
    // honest high-frequency measure — the point of the three colours is that
    // this number falls as the spectrum tilts down.
    const roughness = (color: (typeof NOISE_COLORS)[number]): number => {
      const data = noiseBufferOf(asContext(createFakeAudioContext()), color).getChannelData(0);
      let sum = 0;
      const n = 20000;
      for (let i = 1; i < n; i++) sum += Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0));
      return sum / n;
    };
    const white = roughness("white");
    const pink = roughness("pink");
    const brown = roughness("brown");
    expect(pink).toBeLessThan(white);
    expect(brown).toBeLessThan(pink);
  });
});

describe("enum mapping", () => {
  it("clamps out-of-range indices instead of returning undefined", () => {
    expect(noiseColorFromIndex(-5)).toBe("white");
    expect(noiseColorFromIndex(1)).toBe("pink");
    expect(noiseColorFromIndex(99)).toBe("brown");
    expect(noiseFilterFromIndex(-1)).toBe("lowpass");
    expect(noiseFilterFromIndex(99)).toBe("highpass");
  });
});

describe("voices", () => {
  it("starts a LOOPING source per note — noise has no natural end", () => {
    const { ctx, instance } = rig();
    instance.noteOn?.(60, 100, 0);
    const [src] = sources(ctx);
    expect(src?.loop).toBe(true);
    expect(src?.startedAt).toBe(0);
    expect(src?.stoppedAt).toBeNull(); // nothing stops it but a note-off
  });

  it("puts the note's tracked cutoff on the voice's filter", () => {
    const { ctx, instance } = rig();
    const params = paramPusher(instance);
    params.bind("cutoff");
    params.bind("keyTrack");
    params.push("cutoff", 1000);
    params.push("keyTrack", 100);
    instance.noteOn?.(KEY_TRACK_CENTER_PITCH + 12, 100, 0);
    expect(filters(ctx)[0]?.frequency.value).toBeCloseTo(2000, 3);
  });

  it("releases the voice its OWN note-on made, not whichever holds the pitch", () => {
    const { ctx, instance } = rig();
    instance.noteOn?.(60, 100, 0);
    instance.noteOn?.(60, 100, 1);
    instance.noteOff?.(60, 2);
    const [first, second] = sources(ctx);
    // FIFO pairing: the first note-off answers the first note-on.
    expect(first?.stoppedAt).not.toBeNull();
    expect(second?.stoppedAt).toBeNull();
  });

  it("stops everything on allNotesOff", () => {
    const { ctx, instance } = rig();
    for (let i = 0; i < 4; i++) instance.noteOn?.(60 + i, 100, 0);
    instance.allNotesOff?.(1);
    expect(sources(ctx).every((s) => s.stoppedAt !== null)).toBe(true);
  });

  it("caps polyphony and steals the oldest ringing voice (SS2 budget)", () => {
    const { ctx, instance } = rig();
    for (let i = 0; i <= MAX_VOICES; i++) instance.noteOn?.(40 + i, 100, 0);
    const stopped = sources(ctx).filter((s) => s.stoppedAt !== null);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toBe(sources(ctx)[0]); // oldest first
  });
});
