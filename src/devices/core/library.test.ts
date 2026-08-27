// SS18-M4 device library, headless (SS15): definition validity for every
// core device, the compressor kernel's actual dynamics, and the pure curve
// generators. (Wiring-into-a-graph is covered by the harness's own tests
// plus the M4 e2e; DSP-through-real-audio by the offline export probe.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createParamRegistry, type AppParamRegistry } from "../../params/registry";
import { deviceParamId } from "../../params/paramIds";
import { createDeviceHost } from "../harness/host";
import { createDeviceRegistry, validateDefinition } from "../harness/registry";
import {
  asContext,
  collectingScheduler,
  createFakeAudioContext,
  FakeAudioWorkletNode,
  type FakeAudioContext,
} from "../harness/testing/fakeAudio";
import { Compressor } from "./compressor";
import { CORE_DEVICES } from "./index";
import { CompressorKernel, dbOf, gainOfDb, smoothingCoeff } from "./compressor/kernel";
import {
  makeSaturationCurve,
  REFERENCE_AMPLITUDE,
  saturatorPostGain,
  shapeSample,
} from "./saturator";
import { createSizeCoalescer, makeNoise, quantiseSize } from "./reverb";
import { midiToHz, pluckShapeFromIndex } from "./pluck";
import { StereoDelay } from "./stereoDelay";

describe("the SS18-M4 library", () => {
  it("ships a valid library: 5 instruments + 8 effects", () => {
    for (const def of CORE_DEVICES) expect(() => validateDefinition(def)).not.toThrow();
    const instruments = CORE_DEVICES.filter((d) => d.kind === "instrument");
    const effects = CORE_DEVICES.filter((d) => d.kind === "audioEffect");
    expect(instruments.map((d) => d.id).sort()).toEqual([
      "core.drum-machine",
      "core.fm",
      "core.kick",
      "core.pluck",
      "core.poly-synth",
    ]);
    expect(effects.map((d) => d.id).sort()).toEqual([
      "core.compressor",
      "core.distortion",
      "core.eq3",
      "core.filter",
      "core.overdrive",
      "core.reverb",
      "core.saturator",
      "core.stereo-delay",
    ]);
  });

  it("no two definitions claim the same id", () => {
    const ids = CORE_DEVICES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exactly the compressor declares the SS6 sidechain port", () => {
    const withSc = CORE_DEVICES.filter((d) => d.audioIn.some((port) => port.id === "sc"));
    expect(withSc.map((d) => d.id)).toEqual(["core.compressor"]);
    const sc = withSc[0]?.audioIn.find((port) => port.id === "sc");
    expect(sc?.optional).toBe(true);
  });

  it("every param id is unique within its definition (SS7 public API)", () => {
    for (const def of CORE_DEVICES) {
      const ids = def.params.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("compressor kernel", () => {
  const SR = 48000;
  const block = (value: number, n = 480): Float32Array => new Float32Array(n).fill(value);
  const params = { thresholdDb: -20, ratio: 4, attackMs: 0, releaseMs: 0, makeupDb: 0 };

  it("passes signal below threshold untouched", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(0.05)]; // -26 dB, below -20
    kernel.process(main, main, params);
    expect(main[0]?.[400]).toBeCloseTo(0.05, 5);
    expect(kernel.reductionDb).toBe(0);
  });

  it("compresses above threshold at the stated ratio", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(1)]; // 0 dB, 20 dB over -> reduction = 20 * (1 - 1/4) = 15 dB
    kernel.process(main, main, params);
    expect(kernel.reductionDb).toBeCloseTo(15, 1);
    expect(main[0]?.[400]).toBeCloseTo(gainOfDb(-15), 2);
  });

  it("keys off the SIDECHAIN signal, not the main one", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(0.05)]; // quiet main
    const key = [block(1)]; // loud key
    kernel.process(main, key, params);
    // The quiet main is ducked by the loud key: that IS sidechain pumping.
    expect(kernel.reductionDb).toBeCloseTo(15, 1);
    expect(main[0]?.[400]).toBeCloseTo(0.05 * gainOfDb(-15), 3);
  });

  it("attack smooths the onset; instant attack settles immediately", () => {
    // 100 ms of full-scale input against a 50 ms attack: the envelope is
    // still rising, so reduction is present but short of the settled 15 dB.
    const slowKernel = new CompressorKernel(SR);
    const slow = { ...params, attackMs: 50 };
    const main = [block(1, 4800)];
    slowKernel.process(main, main, slow);
    expect(slowKernel.reductionDb).toBeGreaterThan(0);
    expect(slowKernel.reductionDb).toBeLessThan(15);

    const fastKernel = new CompressorKernel(SR);
    const fastMain = [block(1, 4800)];
    fastKernel.process(fastMain, fastMain, params); // attackMs: 0
    expect(fastKernel.reductionDb).toBeCloseTo(15, 1);
  });

  it("makeup applies as a plain output gain", () => {
    const kernel = new CompressorKernel(SR);
    const main = [block(0.05)];
    kernel.process(main, main, { ...params, makeupDb: 6 });
    expect(main[0]?.[400]).toBeCloseTo(0.05 * gainOfDb(6), 4);
  });

  it("helpers: dbOf/gainOfDb round-trip; coeff bounds sane", () => {
    expect(dbOf(gainOfDb(-12))).toBeCloseTo(-12, 5);
    expect(smoothingCoeff(0, SR)).toBe(0);
    expect(smoothingCoeff(10, SR)).toBeGreaterThan(0.99);
    expect(smoothingCoeff(10, SR)).toBeLessThan(1);
  });
});

describe("pure generators", () => {
  it("saturation curve is odd, bounded, monotonic, unity-slope at the origin", () => {
    const curve = makeSaturationCurve(257);
    expect(curve[128]).toBeCloseTo(0, 6); // center = 0
    expect(curve[0]).toBeCloseTo(-Math.tanh(1), 6);
    expect(curve[256]).toBeCloseTo(Math.tanh(1), 6);
    expect(Math.abs(curve[256]!)).toBeLessThan(1);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    }
    // The whole gain-staging fix: no hidden small-signal gain. The old
    // tanh(x*4)/tanh(4) curve had a slope of ~4 here — +12 dB for free.
    const step = 2 / (curve.length - 1);
    const slope = (curve[129]! - curve[127]!) / (2 * step);
    expect(slope).toBeCloseTo(1, 2);
  });

  it("reverb noise is deterministic per seed (SS12 reproducible renders)", () => {
    const a = makeNoise(1234);
    const b = makeNoise(1234);
    const c = makeNoise(99);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
  });

  it("pluck helpers: A440 and shape clamping", () => {
    expect(midiToHz(69)).toBeCloseTo(440);
    expect(midiToHz(57)).toBeCloseTo(220);
    expect(pluckShapeFromIndex(-3)).toBe("triangle");
    expect(pluckShapeFromIndex(99)).toBe("sawtooth");
  });
});

describe("saturator gain staging (SS7/SS14 — a device may not change level by itself)", () => {
  /** What the device does to a peak of `amplitude` at `driveDb`, mix 100%. */
  function throughDevice(amplitude: number, driveDb: number): number {
    const pre = 10 ** (driveDb / 20);
    return shapeSample(amplitude * pre) * saturatorPostGain(driveDb);
  }

  it("passes a reference-level peak at unity, at any drive", () => {
    for (const drive of [0, 3, 6, 12, 24, 36]) {
      expect(throughDevice(REFERENCE_AMPLITUDE, drive)).toBeCloseTo(REFERENCE_AMPLITUDE, 6);
    }
  });

  it("does not jump the level when dropped in at defaults", () => {
    // Default drive is 6 dB. Across everything from a quiet part to a hot
    // channel the device stays inside +/-6 dB of unity — the residual IS the
    // saturation (a hot peak gives a little back, a quiet one is pushed) —
    // instead of the old unconditional ~+13 dB leap onto the master.
    for (const amplitude of [0.05, 0.2, 0.5, 0.9]) {
      const db = 20 * Math.log10(throughDevice(amplitude, 6) / amplitude);
      expect(db).toBeGreaterThan(-6);
      expect(db).toBeLessThan(6.5);
    }
  });

  it("never lets a full-scale input past full scale", () => {
    for (const drive of [0, 6, 18, 36]) {
      expect(Math.abs(throughDevice(1, drive))).toBeLessThanOrEqual(1);
    }
  });

  it("saturates harder with drive instead of getting louder", () => {
    // A quiet peak keeps rising with drive (it is being pushed into the
    // curve), but the ceiling stops moving once the reference is pinned.
    expect(throughDevice(0.1, 24)).toBeGreaterThan(throughDevice(0.1, 6));
    expect(throughDevice(1, 36)).toBeCloseTo(throughDevice(1, 12), 6);
  });
});

describe("reverb size coalescing (SS2 budget — a knob drag may not rebuild an IR per event)", () => {
  it("quantises to geometric steps, so a full sweep is ~90 rebuilds, not thousands", () => {
    expect(quantiseSize(1.8)).toBeCloseTo(1.8, 1);
    expect(quantiseSize(1.8)).toBe(quantiseSize(1.83)); // within one step
    expect(quantiseSize(1.8)).not.toBe(quantiseSize(2.2));
    const steps = new Set<number>();
    for (let s = 0.1; s <= 8; s += 0.001) steps.add(quantiseSize(s));
    expect(steps.size).toBeLessThan(100);
  });

  it("rate-limits on the AUDIO clock and lands the value the gesture ended on", () => {
    const rebuilt: number[] = [];
    let now = 10;
    const timers: Array<() => void> = [];
    const push = createSizeCoalescer({
      rebuild: (size) => rebuilt.push(size),
      now: () => now,
      defer: (cb) => timers.push(cb),
      minIntervalS: 0.1,
    });

    push(1.8, now); // first value always lands
    expect(rebuilt.length).toBe(1);
    // A 60 Hz drag across the range inside one interval: no more rebuilds.
    for (let i = 1; i <= 6; i++) {
      now += 0.016;
      push(1.8 + i * 0.5, now);
    }
    expect(rebuilt.length).toBe(1);
    // ...but the value the user let go of is not lost.
    timers.forEach((cb) => cb());
    expect(rebuilt.length).toBe(2);
    expect(rebuilt[1]).toBeCloseTo(quantiseSize(4.8), 6);
  });

  it("re-opens the gate once the interval has passed", () => {
    const rebuilt: number[] = [];
    let now = 0;
    const push = createSizeCoalescer({ rebuild: (s) => rebuilt.push(s), now: () => now, minIntervalS: 0.1 });
    push(1, now);
    now = 0.05;
    push(2, now);
    expect(rebuilt.length).toBe(1);
    now = 0.2;
    push(2, now);
    expect(rebuilt.length).toBe(2);
  });

  it("ignores values that land back on the impulse already installed", () => {
    const rebuilt: number[] = [];
    let now = 0;
    const push = createSizeCoalescer({ rebuild: (s) => rebuilt.push(s), now: () => now, minIntervalS: 0 });
    push(1.8, now);
    now = 1;
    push(1.81, now); // same quantised step
    expect(rebuilt.length).toBe(1);
  });

  it("without a `defer` (offline render) nothing depends on a wall clock", () => {
    const rebuilt: number[] = [];
    let now = 0;
    const push = createSizeCoalescer({ rebuild: (s) => rebuilt.push(s), now: () => now, minIntervalS: 0.1 });
    // An SS11 lane sweeping 1 s -> 4 s over half a second of render, sampled
    // at the 200 Hz control rate, then holding. The render clock is the only
    // clock involved, so the same export renders the same way every time.
    for (let i = 0; i < 100; i++) {
      now = i * 0.005;
      push(1 + (3 * i) / 99, now);
    }
    for (let i = 0; i < 40; i++) {
      now = 0.5 + i * 0.005;
      push(4, now); // held: the dropped tail value lands on the next open gate
    }
    expect(rebuilt.length).toBeLessThanOrEqual(8); // 0.7 s of render / 100 ms
    expect(rebuilt.at(-1)).toBeCloseTo(quantiseSize(4), 6);
  });
});

describe("port declarations", () => {
  it("the stereo delay takes a STEREO input so a mono source is not hard-panned", () => {
    const input = StereoDelay.audioIn.find((port) => port.id === "in");
    expect(input?.channels).toBe(2);
  });

  it("the compressor's threshold reads as dB, never as -inf (SS4 readout)", () => {
    const threshold = Compressor.params.find((desc) => desc.id === "threshold");
    expect(threshold?.toText(-60)).toBe("-60.0 dB");
    expect(threshold?.toText(-24)).toBe("-24.0 dB");
  });
});

describe("every shipped definition mounts through the real host (SS7 lifecycle)", () => {
  let ctx: FakeAudioContext;
  let params: AppParamRegistry;
  let timers: ReturnType<typeof collectingScheduler>;

  /** Every worklet node constructed in a test — `new AudioWorkletNode(...)`
   *  bypasses the context, so the stub records them itself. */
  const workletNodes: FakeAudioWorkletNode[] = [];

  class StubAudioWorkletNode extends FakeAudioWorkletNode {
    constructor(_ctx: unknown, name: string, options?: unknown) {
      super(name, options);
      workletNodes.push(this);
    }
  }

  beforeEach(() => {
    ctx = createFakeAudioContext({ currentTime: 1 });
    params = createParamRegistry({ now: () => ctx.currentTime, schedule: () => 0 });
    timers = collectingScheduler();
    workletNodes.length = 0;
    vi.stubGlobal("AudioWorkletNode", StubAudioWorkletNode);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // One table for all eight: SS18-M4's claim is that a new device is one file
  // that needs no wiring elsewhere, so "it mounts, registers and disposes" is
  // exactly the claim to keep executed for every entry.
  for (const definition of CORE_DEVICES) {
    it(`${definition.id} creates, registers every param and disposes`, async () => {
      const devices = createDeviceRegistry();
      devices.register(definition);
      const host = createDeviceHost(asContext(ctx), params, devices, { schedule: timers.schedule });

      const mounted = await host.mount({ definition, instanceId: "d1", channelId: "c1" });

      for (const desc of definition.params) {
        const id = deviceParamId("c1", "d1", desc.id);
        expect(params.get(id), `${definition.id}/${desc.id} is registered`).toBeDefined();
      }
      // Ports the definition declares are all live nodes the reconciler can
      // resolve — including the compressor's optional `sc`.
      for (const port of definition.audioIn) expect(mounted.io.inputs[port.id]).toBeDefined();
      for (const port of definition.audioOut) expect(mounted.io.outputs[port.id]).toBeDefined();

      mounted.dispose();
      for (let i = 0; i < 4; i++) timers.runAll();
      for (const desc of definition.params) {
        expect(params.get(deviceParamId("c1", "d1", desc.id))).toBeUndefined();
      }
      host.dispose();
    });
  }

  // SS6 -> SS7: the reconciler tells a device whether its optional input port
  // is actually fed. The compressor's keying depends on it — without the
  // message the worklet can only infer routing from signal presence, and a
  // routed key that goes quiet falls back to self-keying mid-song.
  it("core.compressor forwards the reconciler's sc routing to its worklet", async () => {
    const devices = createDeviceRegistry();
    devices.register(Compressor);
    const host = createDeviceHost(asContext(ctx), params, devices, { schedule: timers.schedule });
    const mounted = await host.mount({ definition: Compressor, instanceId: "d1", channelId: "c1" });
    const node = workletNodes[0]!;

    expect(typeof mounted.instance.portRouted).toBe("function");
    mounted.instance.portRouted?.("sc", true);
    mounted.instance.portRouted?.("in", false); // not the key port: ignored
    mounted.instance.portRouted?.("sc", false);
    expect(node.posted).toEqual([
      { type: "scRouted", value: true },
      { type: "scRouted", value: false },
    ]);

    mounted.dispose();
    for (let i = 0; i < 4; i++) timers.runAll();
    host.dispose();
  });
});
