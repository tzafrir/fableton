// `core.pluck`'s voice bookkeeping — the part that is not DSP and therefore
// has to be right in plain JS (SS15: no browser needed for the load-bearing
// logic). Everything here drives the real `Pluck.create` against the headless
// context stand-in and asserts on the recorded `AudioParam` automation.

import { describe, expect, it } from "vitest";
import type { DeviceInstance } from "../../types";
import { MAX_VOICES, Pluck } from "./pluck";
import {
  fakeServices,
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeGainNode,
  FakeOscillatorNode,
  type FakeAudioContext,
} from "./testing/fakeAudio";

interface Rig {
  ctx: FakeAudioContext;
  instance: DeviceInstance;
  /** Envelope gains, one per voice, in note-on order. */
  envs(): FakeGainNode[];
  oscillators(): FakeOscillatorNode[];
}

function rig(): Rig {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  const instance = Pluck.create(asContext(ctx), io, fakeServices());
  return {
    ctx,
    instance,
    // buildDeviceIO makes two gains and `create` makes the out gain, so the
    // per-voice envelopes are everything after those three.
    envs: () => ctx.created.filter((n): n is FakeGainNode => n instanceof FakeGainNode).slice(3),
    oscillators: () =>
      ctx.created.filter((n): n is FakeOscillatorNode => n instanceof FakeOscillatorNode),
  };
}

/**
 * Times at which a release was scheduled. A release CANCELS first and then
 * re-targets zero; the note's own decay is a bare `setTargetAtTime(0, ...)`,
 * so the cancel is what separates "let go" from "ringing down".
 */
function releaseTimes(env: FakeGainNode): number[] {
  return env.gain.events.filter((event) => event.kind === "cancel").map((event) => event.time);
}

describe("Pluck voice pairing", () => {
  it("releases the voice its OWN note-on created, not whoever holds the pitch", () => {
    // The reported case: A = tick 0..960, B = tick 480..1440, same pitch.
    const { instance, envs } = rig();
    instance.noteOn?.(60, 100, 0);
    instance.noteOn?.(60, 100, 0.5);
    const [a, b] = envs();
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    instance.noteOff?.(60, 1); // A's note-off
    // B is untouched: only the retrigger choke at 0.5 has released A.
    expect(releaseTimes(a as FakeGainNode)).toEqual([0.5]);
    expect(releaseTimes(b as FakeGainNode)).toEqual([]);

    instance.noteOff?.(60, 1.5); // B's own note-off
    expect(releaseTimes(b as FakeGainNode)).toEqual([1.5]);
  });

  it("pairs note-offs FIFO across pitches", () => {
    const { instance, envs } = rig();
    instance.noteOn?.(60, 100, 0);
    instance.noteOn?.(64, 100, 0);
    instance.noteOff?.(64, 1);
    const [c4, e4] = envs();
    expect(releaseTimes(e4 as FakeGainNode)).toEqual([1]);
    expect(releaseTimes(c4 as FakeGainNode)).toEqual([]);
  });

  it("a voice that ended before its note-off does not steal a later one", () => {
    // Short decay, long note: the oscillator stops itself long before the
    // note-off arrives. The tombstone keeps the pairing honest.
    const { instance, envs, oscillators } = rig();
    instance.noteOn?.(60, 100, 0);
    oscillators()[0]?.end();
    instance.noteOn?.(60, 100, 2);
    instance.noteOff?.(60, 3); // the FIRST note's note-off
    const [, second] = envs();
    expect(releaseTimes(second as FakeGainNode)).toEqual([]);
    instance.noteOff?.(60, 4);
    expect(releaseTimes(second as FakeGainNode)).toEqual([4]);
  });

  it("stops the oscillator just past audibility, not 3x later", () => {
    const { instance, oscillators } = rig();
    instance.noteOn?.(60, 100, 0);
    // Default decay 350 ms -> 2 * 0.35 + RELEASE_S(0.06).
    expect(oscillators()[0]?.stoppedAt).toBeCloseTo(0.76, 6);
  });
});

describe("Pluck polyphony", () => {
  it("caps concurrent voices, stealing the oldest first (SS2 budget)", () => {
    const { instance, envs } = rig();
    for (let i = 0; i < MAX_VOICES + 3; i++) instance.noteOn?.(40 + i, 100, i * 0.01);

    const all = envs();
    expect(all.length).toBe(MAX_VOICES + 3);
    // The three oldest were stolen when voices 24, 25 and 26 arrived.
    expect(releaseTimes(all[0] as FakeGainNode).length).toBe(1);
    expect(releaseTimes(all[1] as FakeGainNode).length).toBe(1);
    expect(releaseTimes(all[2] as FakeGainNode).length).toBe(1);
    expect(releaseTimes(all[3] as FakeGainNode)).toEqual([]);
    expect(releaseTimes(all[MAX_VOICES + 2] as FakeGainNode)).toEqual([]);
  });

  it("allNotesOff releases everything still ringing", () => {
    const { instance, envs } = rig();
    instance.noteOn?.(60, 100, 0);
    instance.noteOn?.(67, 100, 0);
    instance.allNotesOff?.(2);
    for (const env of envs()) expect(releaseTimes(env)).toEqual([2]);
    // And the freed voices are no longer claimable by a stray note-off.
    instance.noteOff?.(60, 3);
    expect(releaseTimes(envs()[0] as FakeGainNode)).toEqual([2]);
  });
});
