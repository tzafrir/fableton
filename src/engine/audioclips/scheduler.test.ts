// The audio-clip scheduler: which clips start, when, and from where in the
// file. Headless — a fake context, a hand-made document, a stub tempo map.

import { describe, expect, it } from "vitest";
import { PPQ } from "../../types";
import type { AssetLibrary, AudioClip, ProjectSnapshot } from "../../types";
import type { TempoMap } from "../../types/time";
import { createAudioClipScheduler, framesPerTick } from "./scheduler";

const BAR = PPQ * 4;
const SR = 48000;

/** A 120 bpm map: one beat is half a second, so a bar is two seconds. */
function tempoMap(): TempoMap {
  const secondsPerTick = 60 / (120 * PPQ);
  return {
    secondsAt: (tick: number) => tick * secondsPerTick,
    ticksAt: (seconds: number) => Math.round(seconds / secondsPerTick),
    secondsBetween: (from: number, to: number) => (to - from) * secondsPerTick,
    bpmAt: () => 120,
  } as unknown as TempoMap;
}

interface FakeSource {
  buffer: AudioBuffer | null;
  started: { when: number; offset: number; duration: number } | null;
  stoppedAt: number | null;
  onended: (() => void) | null;
  connect(): void;
  disconnect(): void;
  start(when: number, offset: number, duration: number): void;
  stop(when: number): void;
}

function rig(
  clips: readonly AudioClip[],
  options: { duration?: number; missingInput?: boolean; missingBuffer?: boolean } = {},
) {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 0,
    createBufferSource: () => {
      const src: FakeSource = {
        buffer: null,
        started: null,
        stoppedAt: null,
        onended: null,
        connect: () => undefined,
        disconnect: () => undefined,
        start(when: number, offset: number, duration: number) {
          this.started = { when, offset, duration };
        },
        stop(when: number) {
          this.stoppedAt = when;
        },
      };
      sources.push(src);
      return src;
    },
    createGain: () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }),
  } as unknown as BaseAudioContext;

  const buffer = {
    duration: options.duration ?? 10,
    sampleRate: SR,
    numberOfChannels: 1,
    length: (options.duration ?? 10) * SR,
  } as AudioBuffer;

  const assets: AssetLibrary = {
    buffer: () => (options.missingBuffer === true ? undefined : buffer),
    onChange: () => () => undefined,
  };

  const doc = {
    tempo: [{ startTick: 0, bpm: 120 }],
    assets: { "asset-1": { id: "asset-1", name: "a.wav", sampleRate: SR, channels: 1, frames: SR * 10 } },
    audioClips: Object.fromEntries(clips.map((c) => [c.id, c])),
  } as unknown as ProjectSnapshot;

  const destination = {} as AudioNode;
  const scheduler = createAudioClipScheduler({
    ctx,
    doc: () => doc,
    tempoMap,
    assets,
    inputFor: () => (options.missingInput === true ? undefined : destination),
  });
  return { scheduler, sources };
}

function clip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: "audio",
    id: "ac-1",
    trackId: "track-1",
    start: BAR,
    length: BAR,
    assetId: "asset-1",
    offsetFrames: 0,
    gainDb: 0,
    ...overrides,
  };
}

describe("framesPerTick", () => {
  it("is the file's own rate against the song's tempo", () => {
    // At 120 bpm a beat is 0.5 s; at 48 kHz that is 24,000 frames per beat.
    expect(framesPerTick(48000, 120, PPQ) * PPQ).toBeCloseTo(24000, 3);
  });
});

describe("scheduling into the window", () => {
  it("starts a clip whose start falls inside the window", () => {
    const { scheduler, sources } = rig([clip()]);
    // Window covering bar 2, ending at audio-clock second 4.
    scheduler.fillWindow(4, BAR, BAR * 2);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.started?.offset).toBe(0);
    // The clip starts at the very start of the window, which is two seconds
    // before the horizon.
    expect(sources[0]?.started?.when).toBeCloseTo(2, 6);
    // ...and plays for its own length: one bar = two seconds.
    expect(sources[0]?.started?.duration).toBeCloseTo(2, 6);
  });

  it("ignores a clip that starts outside the window", () => {
    const { scheduler, sources } = rig([clip({ start: BAR * 8 })]);
    scheduler.fillWindow(4, BAR, BAR * 2);
    expect(sources).toHaveLength(0);
  });

  it("starts from the clip's own offset into the file", () => {
    const { scheduler, sources } = rig([clip({ offsetFrames: SR })]); // one second in
    scheduler.fillWindow(4, BAR, BAR * 2);
    expect(sources[0]?.started?.offset).toBeCloseTo(1, 6);
  });

  it("never asks for more of the file than there is", () => {
    // A clip four bars long over a one-second file.
    const { scheduler, sources } = rig([clip({ length: BAR * 4 })], { duration: 1 });
    expect(sources).toHaveLength(0);
    scheduler.fillWindow(4, BAR, BAR * 2);
    expect(sources[0]?.started?.duration).toBeCloseTo(1, 6);
  });

  it("plays nothing when the sample has not decoded, or the track has no input", () => {
    const missing = rig([clip()], { missingBuffer: true });
    missing.scheduler.fillWindow(4, BAR, BAR * 2);
    expect(missing.sources).toHaveLength(0);

    const unrouted = rig([clip()], { missingInput: true });
    unrouted.scheduler.fillWindow(4, BAR, BAR * 2);
    expect(unrouted.sources).toHaveLength(0);
  });

  it("does not start a clip twice when the window advances past it", () => {
    const { scheduler, sources } = rig([clip()]);
    scheduler.fillWindow(4, BAR, BAR * 2);
    scheduler.fillWindow(6, BAR * 2, BAR * 3);
    expect(sources).toHaveLength(1);
  });
});

describe("jumps (play from the middle, seek, loop wrap)", () => {
  it("starts a clip that CONTAINS the new position, partway into the file", () => {
    // The bug this rules out: pressing play in the middle of a long take
    // produces silence until the next time the clip's start goes by.
    const { scheduler, sources } = rig([clip({ start: 0, length: BAR * 4 })]);
    scheduler.fillWindow(2, 0, BAR); // a normal first window: the clip starts
    expect(sources).toHaveLength(1);

    scheduler.fillWindow(20, BAR * 2, BAR * 3); // ...then a jump to bar 3
    expect(sources).toHaveLength(2);
    // Two bars into the clip = four seconds into the file.
    expect(sources[1]?.started?.offset).toBeCloseTo(4, 3);
    // ...and it plays out the clip's remaining two bars.
    expect(sources[1]?.started?.duration).toBeCloseTo(4, 3);
  });

  it("silences what was playing for the OLD position on a jump", () => {
    const { scheduler, sources } = rig([clip({ start: 0, length: BAR * 4 })]);
    scheduler.fillWindow(2, 0, BAR);
    scheduler.fillWindow(20, BAR * 2, BAR * 3);
    expect(sources[0]?.stoppedAt).not.toBeNull();
  });

  it("treats the FIRST window as normal, not as a jump", () => {
    const { scheduler, sources } = rig([clip({ start: 0, length: BAR * 4 })]);
    scheduler.fillWindow(2, 0, BAR);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.started?.offset).toBe(0);
  });
});

describe("lifecycle", () => {
  it("stopAll silences everything and forgets where the window was", () => {
    const { scheduler, sources } = rig([clip({ start: 0 })]);
    scheduler.fillWindow(2, 0, BAR);
    scheduler.stopAll(1);
    expect(sources[0]?.stoppedAt).toBe(1);
    // ...and the next window is a fresh start, not a jump.
    scheduler.fillWindow(4, BAR, BAR * 2);
    expect(sources).toHaveLength(1);
  });

  it("forgets a source once it ends", () => {
    const { scheduler, sources } = rig([clip({ start: 0 })]);
    scheduler.fillWindow(2, 0, BAR);
    expect(scheduler.playingCount()).toBe(1);
    sources[0]?.onended?.();
    expect(scheduler.playingCount()).toBe(0);
  });

  it("schedules nothing after dispose", () => {
    const { scheduler, sources } = rig([clip({ start: 0 })]);
    scheduler.dispose();
    scheduler.fillWindow(2, 0, BAR);
    expect(sources).toHaveLength(0);
  });

  it("does nothing at all for a project with no audio clips", () => {
    const { scheduler, sources } = rig([]);
    scheduler.fillWindow(2, 0, BAR);
    expect(sources).toHaveLength(0);
    expect(scheduler.playingCount()).toBe(0);
  });
});
