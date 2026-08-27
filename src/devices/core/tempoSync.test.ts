// Tempo-synced times (SS8): note divisions, the delay that locks to them,
// and the filter's LFO.

import { describe, expect, it } from "vitest";
import type { DeviceInstance, ParamHandle } from "../../types";
import { Filter } from "./filter";
import { StereoDelay } from "./stereoDelay";
import {
  NOTE_DIVISIONS,
  NOTE_DIVISION_LABELS,
  divisionBeats,
  divisionHz,
  divisionIndex,
  divisionSeconds,
} from "./noteDivisions";
import {
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  fakeServices,
  FakeBiquadNode,
  FakeDelayNode,
  FakeGainNode,
  FakeOscillatorNode,
  fakeOf,
  type FakeAudioContext,
} from "./testing/fakeAudio";

/** Binds every param the device offers and returns pushers for them. */
function bindAll(instance: DeviceInstance, ids: readonly string[]) {
  const writers = new Map<string, (value: number, when: number) => void>();
  for (const id of ids) {
    const handle = {
      bindMessage: (write: (value: number, when: number) => void) => writers.set(id, write),
      bindAudioParam: () => undefined,
    } as unknown as ParamHandle;
    instance.connectParam?.(id, handle);
  }
  return (id: string, value: number, when = 0): void => writers.get(id)?.(value, when);
}

describe("note divisions", () => {
  it("counts QUARTER notes, so one multiply converts to seconds", () => {
    expect(divisionBeats(divisionIndex("1/4"))).toBe(1);
    expect(divisionBeats(divisionIndex("1/1"))).toBe(4);
    expect(divisionBeats(divisionIndex("1/8"))).toBe(0.5);
    expect(divisionBeats(divisionIndex("1/8."))).toBe(0.75); // dotted = 1.5x
    expect(divisionBeats(divisionIndex("1/8T"))).toBeCloseTo(1 / 3, 10); // triplet = 2/3x
  });

  it("runs longest to shortest, so a knob sweeping up gets faster", () => {
    const beats = NOTE_DIVISIONS.map((d) => d.beats);
    for (let i = 1; i < beats.length; i += 1) {
      expect(beats[i]).toBeLessThan(beats[i - 1] as number);
    }
    expect(NOTE_DIVISION_LABELS).toHaveLength(NOTE_DIVISIONS.length);
  });

  it("converts to seconds and Hz at a given beat length", () => {
    // 120 bpm: a beat is 0.5 s, so 1/8 is 0.25 s and 4 Hz.
    expect(divisionSeconds(divisionIndex("1/8"), 0.5)).toBe(0.25);
    expect(divisionHz(divisionIndex("1/8"), 0.5)).toBe(4);
    // A nonsense beat length falls back to 120 bpm rather than NaN.
    expect(divisionSeconds(divisionIndex("1/4"), 0)).toBe(0.5);
    expect(divisionBeats(999)).toBe(NOTE_DIVISIONS[NOTE_DIVISIONS.length - 1]?.beats);
  });
});

function delayRig(bpm = 120) {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  const services = fakeServices(bpm);
  const instance = StereoDelay.create(asContext(ctx), io, services);
  const delays = ctx.created.filter((n): n is FakeDelayNode => n instanceof FakeDelayNode);
  const push = bindAll(instance, ["sync", "divL", "divR", "timeL", "timeR"]);
  const lastTime = (index: number): number =>
    delays[index]?.delayTime.events.at(-1)?.value ?? Number.NaN;
  return { ctx, instance, services, push, lastTime };
}

describe("the stereo delay's sync", () => {
  it("uses the ms times while sync is OFF", () => {
    const { push, lastTime } = delayRig();
    push("timeL", 500);
    expect(lastTime(0)).toBeCloseTo(0.5, 6);
  });

  it("locks to the division while sync is ON, ignoring the ms times", () => {
    const { push, lastTime } = delayRig(120);
    push("divL", divisionIndex("1/8"));
    push("timeL", 500);
    push("sync", 1);
    // 1/8 at 120 bpm = 0.25 s — not the 500 ms the ms param still holds.
    expect(lastTime(0)).toBeCloseTo(0.25, 6);

    push("timeL", 900);
    expect(lastTime(0)).toBeCloseTo(0.25, 6); // still the division
  });

  it("follows a tempo change while synced, and ignores one while not", () => {
    const rig = delayRig(120);
    rig.push("divL", divisionIndex("1/4"));
    rig.push("sync", 1);
    expect(rig.lastTime(0)).toBeCloseTo(0.5, 6);
    rig.services.setBpm(60); // a beat is now 1 s
    expect(rig.lastTime(0)).toBeCloseTo(1, 6);

    const free = delayRig(120);
    free.push("timeL", 300);
    const before = free.lastTime(0);
    free.services.setBpm(60);
    expect(free.lastTime(0)).toBe(before);
  });

  it("clamps to the delay line's length rather than asking for more", () => {
    const { push, lastTime } = delayRig(30); // a beat is 2 s
    push("divL", divisionIndex("1/1")); // 4 beats = 8 s, past the 2 s line
    push("sync", 1);
    expect(lastTime(0)).toBeLessThanOrEqual(2);
  });
});

function filterRig(bpm = 120) {
  const ctx: FakeAudioContext = createFakeAudioContext();
  const { io, input } = buildDeviceIO(ctx);
  const services = fakeServices(bpm);
  const instance = Filter.create(asContext(ctx), io, services);
  const filterNode = fakeOf(input.connectedTo[0]) as FakeBiquadNode;
  const lfo = ctx.created.find((n): n is FakeOscillatorNode => n instanceof FakeOscillatorNode);
  const depth = ctx.created.find(
    (n): n is FakeGainNode => n instanceof FakeGainNode && n.connectedTo.includes(filterNode.detune),
  );
  const push = bindAll(instance, ["lfoShape", "lfoDepth", "lfoSync", "lfoDiv", "lfoRate"]);
  return { ctx, instance, services, push, filterNode, lfo, depth };
}

describe("the filter's LFO", () => {
  it("modulates DETUNE, not frequency — so the sweep is musically even", () => {
    const { depth, lfo } = filterRig();
    // Modulating `frequency` in Hz would be an octave at 100 Hz and
    // inaudible at 10 kHz; `detune` is in cents, so the interval is the same
    // wherever the cutoff sits.
    expect(depth).toBeDefined();
    expect(lfo?.startedAt).not.toBeNull();
  });

  it("is silent at defaults: adding a filter is still just a filter", () => {
    const { depth } = filterRig();
    expect(depth?.gain.value).toBe(0);
  });

  it("converts a depth in semitones to cents", () => {
    const { push, depth } = filterRig();
    push("lfoDepth", 12);
    expect(depth?.gain.events.at(-1)?.value).toBe(1200);
  });

  it("locks the rate to a note division when synced, and follows the tempo", () => {
    const rig = filterRig(120);
    rig.push("lfoRate", 7);
    expect(rig.lfo?.frequency.events.at(-1)?.value).toBeCloseTo(7, 6);

    rig.push("lfoDiv", divisionIndex("1/4"));
    rig.push("lfoSync", 1);
    expect(rig.lfo?.frequency.events.at(-1)?.value).toBeCloseTo(2, 6); // 0.5 s

    rig.services.setBpm(60);
    expect(rig.lfo?.frequency.events.at(-1)?.value).toBeCloseTo(1, 6); // 1 s
  });

  it("switches waveform without restarting the oscillator", () => {
    const { push, lfo } = filterRig();
    const started = lfo?.startedAt;
    push("lfoShape", 2);
    expect(lfo?.type).toBe("square");
    // Restarting would need a NEW node (oscillators are one-shot) and would
    // jump the LFO's phase.
    expect(lfo?.startedAt).toBe(started);
  });
});
