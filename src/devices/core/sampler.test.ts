// `core.sampler` — headless, against the fake context (SS15).

import { describe, expect, it } from "vitest";
import type { AssetLibrary, DeviceInstance, DeviceServices, ParamHandle } from "../../types";
import { validateDefinition } from "../harness";
import { MAX_VOICES, SAMPLE_SETTING_KEY, Sampler, playbackRateFor, sliceOf } from "./sampler";
import {
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeBufferSourceNode,
  fakeServices,
  type FakeAudioContext,
} from "./testing/fakeAudio";

/** A stand-in `AudioBuffer` — the sampler reads only duration and hands the
 *  object straight to a buffer source. */
function fakeBuffer(durationSeconds = 2): AudioBuffer {
  return {
    duration: durationSeconds,
    sampleRate: 48000,
    numberOfChannels: 2,
    length: Math.round(durationSeconds * 48000),
  } as unknown as AudioBuffer;
}

function libraryWith(entries: Record<string, AudioBuffer>): AssetLibrary {
  return {
    buffer: (id) => entries[id],
    onChange: () => () => undefined,
  };
}

function rig(assets: AssetLibrary = libraryWith({})): {
  ctx: FakeAudioContext;
  instance: DeviceInstance;
} {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  const services: DeviceServices = { ...fakeServices(), assets };
  return { ctx, instance: Sampler.create(asContext(ctx), io, services) };
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

describe("the definition", () => {
  it("passes the harness's own validator", () => {
    expect(() => validateDefinition(Sampler)).not.toThrow();
  });

  it("declares its file as a SETTING, never as a param", () => {
    expect(Sampler.settings).toEqual([
      { key: SAMPLE_SETTING_KEY, label: "Sample", kind: "audioAsset" },
    ]);
    expect(Sampler.params.some((p) => p.id === SAMPLE_SETTING_KEY)).toBe(false);
  });
});

describe("playbackRateFor", () => {
  it("plays the root note untransposed", () => {
    expect(playbackRateFor(60, 60, 0, 0)).toBe(1);
  });

  it("doubles an octave up and halves an octave down", () => {
    expect(playbackRateFor(72, 60, 0, 0)).toBeCloseTo(2, 10);
    expect(playbackRateFor(48, 60, 0, 0)).toBeCloseTo(0.5, 10);
  });

  it("adds tune in semitones and fine in cents on top", () => {
    expect(playbackRateFor(60, 60, 12, 0)).toBeCloseTo(2, 10);
    expect(playbackRateFor(60, 60, 0, 100)).toBeCloseTo(2 ** (1 / 12), 10);
    expect(playbackRateFor(60, 72, 12, 0)).toBeCloseTo(1, 10);
  });
});

describe("sliceOf", () => {
  it("is the whole file at 0..100%", () => {
    expect(sliceOf(2, 0, 100)).toEqual({ offset: 0, duration: 2 });
  });

  it("takes a middle region", () => {
    expect(sliceOf(4, 25, 75)).toEqual({ offset: 1, duration: 2 });
  });

  it("survives start past end by treating the pair as a range", () => {
    // Otherwise a negative duration reaches `start(when, offset, duration)`
    // and the voice either never stops or throws.
    expect(sliceOf(4, 75, 25)).toEqual({ offset: 1, duration: 2 });
  });

  it("never produces a zero-length or out-of-range slice", () => {
    expect(sliceOf(4, 100, 100).duration).toBeGreaterThan(0);
    expect(sliceOf(4, 0, 0).duration).toBeGreaterThan(0);
    const s = sliceOf(4, 90, 200);
    expect(s.offset + s.duration).toBeLessThanOrEqual(4);
  });
});

describe("playing", () => {
  it("is silent until a sample is chosen", () => {
    const { ctx, instance } = rig(libraryWith({ "asset-1": fakeBuffer() }));
    instance.noteOn?.(60, 100, 0);
    expect(sources(ctx)).toHaveLength(0);
  });

  it("is silent while its chosen sample is still decoding, and sounds after", () => {
    // The buffer is resolved PER NOTE for exactly this: a project loads long
    // before its audio finishes decoding.
    const entries: Record<string, AudioBuffer> = {};
    const { ctx, instance } = rig(libraryWith(entries));
    instance.setSetting?.(SAMPLE_SETTING_KEY, "asset-1");
    instance.noteOn?.(60, 100, 0);
    expect(sources(ctx)).toHaveLength(0);

    entries["asset-1"] = fakeBuffer();
    instance.noteOn?.(60, 100, 1);
    expect(sources(ctx)).toHaveLength(1);
  });

  it("stops playing when the setting is cleared", () => {
    const { ctx, instance } = rig(libraryWith({ "asset-1": fakeBuffer() }));
    instance.setSetting?.(SAMPLE_SETTING_KEY, "asset-1");
    instance.noteOn?.(60, 100, 0);
    instance.setSetting?.(SAMPLE_SETTING_KEY, null);
    instance.noteOn?.(60, 100, 1);
    expect(sources(ctx)).toHaveLength(1);
  });

  it("pitches by playback rate against the root note", () => {
    const { ctx, instance } = rig(libraryWith({ "asset-1": fakeBuffer() }));
    const params = paramPusher(instance);
    params.bind("root");
    params.push("root", 60);
    instance.setSetting?.(SAMPLE_SETTING_KEY, "asset-1");
    instance.noteOn?.(72, 100, 0);
    expect(
      (sources(ctx)[0] as unknown as { playbackRate: { value: number } }).playbackRate.value,
    ).toBeCloseTo(2, 6);
  });

  it("one-shots stop themselves; looping voices wait for their note-off", () => {
    const { ctx, instance } = rig(libraryWith({ "asset-1": fakeBuffer() }));
    const params = paramPusher(instance);
    params.bind("loop");
    instance.setSetting?.(SAMPLE_SETTING_KEY, "asset-1");

    instance.noteOn?.(60, 100, 0);
    expect(sources(ctx)[0]?.loop).toBe(false);

    params.push("loop", 1);
    instance.noteOn?.(62, 100, 0);
    const looped = sources(ctx)[1];
    expect(looped?.loop).toBe(true);
    expect(looped?.stoppedAt).toBeNull();
    instance.noteOff?.(62, 1);
    expect(looped?.stoppedAt).not.toBeNull();
  });

  it("caps polyphony and steals the oldest ringing voice (SS2 budget)", () => {
    const { ctx, instance } = rig(libraryWith({ "asset-1": fakeBuffer() }));
    const params = paramPusher(instance);
    params.bind("loop");
    params.push("loop", 1); // looping voices never end on their own
    instance.setSetting?.(SAMPLE_SETTING_KEY, "asset-1");
    for (let i = 0; i <= MAX_VOICES; i++) instance.noteOn?.(40 + i, 100, 0);
    const stopped = sources(ctx).filter((s) => s.stoppedAt !== null);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toBe(sources(ctx)[0]);
  });

  it("stops everything on allNotesOff", () => {
    const { ctx, instance } = rig(libraryWith({ "asset-1": fakeBuffer() }));
    instance.setSetting?.(SAMPLE_SETTING_KEY, "asset-1");
    for (let i = 0; i < 3; i++) instance.noteOn?.(60 + i, 100, 0);
    instance.allNotesOff?.(1);
    expect(sources(ctx).every((s) => s.stoppedAt !== null)).toBe(true);
  });
});
