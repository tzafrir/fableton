import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateDeviceInstance, DeviceInstance, ParamHandle } from "../../types";
import { createParamRegistry, type AppParamRegistry } from "../../params/registry";
import { deviceParamId, qualifyDescriptor } from "../../params/paramIds";
import { p } from "./params";
import {
  DEFAULT_RAMP_OUT_MS,
  createDeviceInstance,
  dbToGain,
  deviceInstance,
  gainForValue,
  mappedParam,
  msParam,
  rampOutAndDisconnect,
  scaledParam,
} from "./deviceInstance";
import {
  FakeDelayNode,
  FakeGainNode,
  asGain,
  asParam,
  collectingScheduler,
  createFakeAudioContext,
} from "./testing/fakeAudio";

let registry: AppParamRegistry;
let clock: number;

beforeEach(() => {
  clock = 0;
  registry = createParamRegistry({ now: () => clock, schedule: () => 0 });
});

/** Registers a device-local descriptor at `chan:t1/dev:d1/<id>` and binds it. */
function bind(instance: DeviceInstance, desc: ReturnType<typeof p.hz>): ParamHandle {
  const handle = registry.register(
    qualifyDescriptor(desc, { channelId: "t1", instanceId: "d1" }),
  );
  instance.connectParam(desc.id, handle);
  return handle;
}

describe("deviceInstance param binding (SS7/SS14)", () => {
  it("satisfies the frozen CreateDeviceInstance signature", () => {
    const asContract: CreateDeviceInstance = createDeviceInstance;
    expect(typeof asContract).toBe("function");
    const inst = asContract({ dispose: () => {} });
    expect(typeof inst.connectParam).toBe("function");
  });

  it("binds an audioParam on the native fast path, in real units", () => {
    const filter = createFakeAudioContext().createBiquadFilter();
    const inst = deviceInstance({
      audioParams: { cutoff: asParam(filter.frequency) },
      dispose: () => {},
    });
    const handle = bind(inst, p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 1000 }));

    // Binding pushes the current value immediately (no click on mount).
    expect(filter.frequency.value).toBe(1000);
    handle.setLive(440, "user");
    expect(filter.frequency.value).toBe(440);
    expect(filter.frequency.events.some((e) => e.kind === "linear")).toBe(true);
    expect(handle.desc.id).toBe(deviceParamId("t1", "d1", "cutoff"));
  });

  it("converts units on a scaled param — the SS14 ms -> s delay time", () => {
    const delay = new FakeDelayNode();
    const inst = deviceInstance({
      scaledParams: { timeL: msParam(asParam(delay.delayTime)) },
      dispose: () => {},
    });
    const handle = bind(inst, p.time("timeL", "Time L", { min: 1, max: 2000, default: 250 }));

    expect(delay.delayTime.value).toBeCloseTo(0.25, 10);
    handle.setLive(375, "user");
    expect(delay.delayTime.value).toBeCloseTo(0.375, 10);
    // The DOCUMENT value stays in real units — only the engine sees seconds.
    handle.commit();
    expect(handle.base()).toBe(375);
  });

  it("maps an arbitrary curve with mappedParam / scaledParam", () => {
    const delay = new FakeDelayNode();
    const inst = deviceInstance({
      scaledParams: {
        detune: mappedParam(asParam(delay.delayTime), (st) => 2 ** (st / 12)),
      },
      dispose: () => {},
    });
    bind(inst, p.st("detune", "Detune", { min: -12, max: 12, default: 12 }));
    expect(delay.delayTime.value).toBeCloseTo(2, 10);

    const other = new FakeDelayNode();
    expect(scaledParam(asParam(other.delayTime), 2).map(3)).toBe(6);
  });

  it("drives a single gain from a % param (feedback 35 -> 0.35)", () => {
    const fb = new FakeGainNode();
    const inst = deviceInstance({
      gainParams: { feedback: asGain(fb) },
      dispose: () => {},
    });
    const handle = bind(inst, p.pct("feedback", "Feedback", { default: 35, max: 95 }));
    expect(fb.gain.value).toBeCloseTo(0.35, 10);
    handle.setLive(90, "user");
    expect(fb.gain.value).toBeCloseTo(0.9, 10);
  });

  it("crossfades a [wet, dry] pair with equal power (SS14 mix)", () => {
    const wet = new FakeGainNode();
    const dry = new FakeGainNode();
    const inst = deviceInstance({
      gainParams: { mix: [asGain(wet), asGain(dry)] },
      dispose: () => {},
    });
    const handle = bind(inst, p.pct("mix", "Mix", { default: 25 }));

    const power = (): number => wet.gain.value ** 2 + dry.gain.value ** 2;
    expect(wet.gain.value).toBeCloseTo(Math.sin((0.25 * Math.PI) / 2), 10);
    expect(dry.gain.value).toBeCloseTo(Math.cos((0.25 * Math.PI) / 2), 10);
    expect(power()).toBeCloseTo(1, 10);

    handle.setLive(100, "user");
    expect(wet.gain.value).toBeCloseTo(1, 10);
    expect(dry.gain.value).toBeCloseTo(0, 10);
    expect(power()).toBeCloseTo(1, 10);

    handle.setLive(0, "user");
    expect(wet.gain.value).toBeCloseTo(0, 10);
    expect(dry.gain.value).toBeCloseTo(1, 10);
  });

  it("converts dB gains, with silence at the bottom of a fader range", () => {
    const out = new FakeGainNode();
    const inst = deviceInstance({ gainParams: { level: asGain(out) }, dispose: () => {} });
    const handle = bind(inst, p.db("level", "Level", { min: -60, max: 6, default: 0 }));
    expect(out.gain.value).toBeCloseTo(1, 10);
    handle.setLive(-6, "user");
    expect(out.gain.value).toBeCloseTo(dbToGain(-6), 10);
    handle.setLive(-60, "user");
    expect(out.gain.value).toBe(0);
    expect(gainForValue(handle.desc, 6)).toBeCloseTo(10 ** (6 / 20), 10);
    // ...and "silent" is exactly what the descriptor's own readout promises
    // (SS4: `toText` is the sanctioned view of the real value).
    expect(handle.desc.toText(-60)).toBe("-inf dB");
    expect(gainForValue(handle.desc, -60)).toBe(0);
  });

  it("forwards messageParams and falls back to a custom connectParam", () => {
    const seen: Array<{ id: string; v: number }> = [];
    const custom: string[] = [];
    const inst = deviceInstance({
      messageParams: { voices: (v) => seen.push({ id: "voices", v }) },
      connectParam: (localId) => custom.push(localId),
      dispose: () => {},
    });
    bind(inst, p.stepped("voices", "Voices", { min: 1, max: 8, default: 4, step: 1 }));
    bind(inst, p.pct("spread", "Spread", { default: 50 }));

    expect(seen.at(-1)).toEqual({ id: "voices", v: 4 });
    expect(custom).toEqual(["spread"]);
  });

  it("leaves an unclaimed param registered but with no live target (SS7)", () => {
    const inst = deviceInstance({ dispose: () => {} });
    const handle = bind(inst, p.pct("unused", "Unused", { default: 10 }));
    expect(() => handle.setLive(20, "user")).not.toThrow();
    expect(handle.live()).toBe(20);
    expect(registry.list()).toHaveLength(1);
  });

  it("refuses a local id bound on two fast paths", () => {
    const gain = new FakeGainNode();
    expect(() =>
      deviceInstance({
        audioParams: { mix: asParam(gain.gain) },
        gainParams: { mix: asGain(gain) },
        dispose: () => {},
      }),
    ).toThrow(/bound twice/);
  });
});

describe("deviceInstance lifecycle", () => {
  it("exposes note methods only when the device implements them", () => {
    const effect = deviceInstance({ dispose: () => {} });
    expect(effect.noteOn).toBeUndefined();
    expect(effect.allNotesOff).toBeUndefined();

    const notes: string[] = [];
    const instrument = deviceInstance({
      noteOn: (pitch, vel, when) => notes.push(`on ${pitch}/${vel}@${when}`),
      noteOff: (pitch, when) => notes.push(`off ${pitch}@${when}`),
      allNotesOff: (when) => notes.push(`panic@${when}`),
      dispose: () => {},
    });
    instrument.noteOn?.(60, 100, 1.5);
    instrument.noteOff?.(60, 2);
    instrument.allNotesOff?.(3);
    expect(notes).toEqual(["on 60/100@1.5", "off 60@2", "panic@3"]);
  });

  it("reports zero latency by default and the device's own value otherwise", () => {
    expect(deviceInstance({ dispose: () => {} }).latencySamples?.()).toBe(0);
    expect(
      deviceInstance({ latencySamples: () => 128, dispose: () => {} }).latencySamples?.(),
    ).toBe(128);
  });

  it("runs the author's dispose exactly once and stops binding afterwards", () => {
    const disposeSpy = vi.fn();
    const gain = new FakeGainNode();
    const inst = deviceInstance({ gainParams: { mix: asGain(gain) }, dispose: disposeSpy });
    inst.dispose(2);
    inst.dispose(3);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledWith(2);

    const before = gain.gain.events.length;
    bind(inst, p.pct("mix", "Mix", { default: 50 }));
    expect(gain.gain.events.length).toBe(before);
  });
});

describe("rampOutAndDisconnect (SS7 gain-ramped removal)", () => {
  it("fades to zero from `when` and disconnects after the fade", () => {
    const ctx = createFakeAudioContext({ currentTime: 10 });
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const extra = ctx.createChannelSplitter();
    const timers = collectingScheduler();

    rampOutAndDisconnect(10.5, [asGain(dry), asGain(wet)], {
      context: ctx as unknown as BaseAudioContext,
      also: [extra as unknown as AudioNode],
      schedule: timers.schedule,
    });

    for (const node of [dry, wet]) {
      const last = node.gain.events.at(-1);
      expect(last?.kind).toBe("linear");
      expect(last?.value).toBe(0);
      expect(last?.time).toBeCloseTo(10.5 + DEFAULT_RAMP_OUT_MS / 1000, 10);
    }
    // Waits out the 500 ms until `when`, then the fade, then a little slack.
    expect(timers.calls[0]?.ms).toBeGreaterThanOrEqual(500 + DEFAULT_RAMP_OUT_MS);
    expect(dry.disconnectCount).toBe(0);

    // Waking before the audio clock has reached the end of the fade re-arms;
    // the disconnect is gated on `ctx.currentTime`, not on the wall clock.
    timers.runAll();
    expect(dry.disconnectCount).toBe(0);

    ctx.currentTime = 11;
    timers.runAll();
    expect(dry.disconnectCount).toBe(1);
    expect(wet.disconnectCount).toBe(1);
    expect(extra.disconnectCount).toBe(1);
  });

  it("anchors a future fade at the value it will really have, not the one read now", () => {
    // `dispose(when)`/`unmount(id, when)` schedule the fade in the FUTURE
    // (SS7's ~20 ms swap crossfade). Anchoring it with
    // `setValueAtTime(param.value, when)` steps the param back to whatever it
    // reads at scheduling time, undoing any automation between now and `when`
    // — a click at the head of the fade the ramp exists to prevent.
    const ctx = createFakeAudioContext({ currentTime: 10 });
    const gain = ctx.createGain();
    const timers = collectingScheduler();

    rampOutAndDisconnect(10.5, [asGain(gain)], {
      context: ctx as unknown as BaseAudioContext,
      schedule: timers.schedule,
    });

    expect(gain.gain.events.map((e) => e.kind)).toEqual(["hold", "linear"]);
    expect(gain.gain.events[0]?.time).toBeCloseTo(10.5, 10);
  });

  it("treats a past or missing `when` as now", () => {
    const ctx = createFakeAudioContext({ currentTime: 4 });
    const gain = ctx.createGain();
    const timers = collectingScheduler();
    rampOutAndDisconnect(undefined, [asGain(gain)], {
      context: ctx as unknown as BaseAudioContext,
      rampMs: 50,
      schedule: timers.schedule,
    });
    expect(gain.gain.events.at(-1)?.time).toBeCloseTo(4 + 0.05, 10);
    expect(timers.calls[0]?.ms).toBeGreaterThanOrEqual(50);
  });

  it("gives up and disconnects once a stalled context has run out the budget", () => {
    // Belt and braces for the audio-clock gate above: a context that never
    // advances again (a tab that is never returned to) must not keep the
    // nodes connected forever. It is silent, so the eventual cut is inaudible.
    const ctx = createFakeAudioContext({ currentTime: 4 });
    const gain = ctx.createGain();
    const timers = collectingScheduler();
    rampOutAndDisconnect(undefined, [asGain(gain)], {
      context: ctx as unknown as BaseAudioContext,
      schedule: timers.schedule,
    });

    let rounds = 0;
    while (gain.disconnectCount === 0 && rounds < 1000) {
      timers.runAll();
      rounds++;
    }
    expect(gain.disconnectCount).toBe(1);
  });
});
