// `core.fm` — the four-operator Operator, and the algorithm table that wires
// it. Headless against the fake context (SS15: the load-bearing logic needs
// no browser).
//
// The claims worth testing here are the ones a picture cannot settle: that
// the graph a given algorithm builds is the one its label promises, that a
// modulator lands on its target's FREQUENCY (which is the whole difference
// between FM and four oscillators playing at once), and that the numbers on
// the panel mean what the header says they mean.

import { describe, expect, it } from "vitest";
import type { DeviceInstance, ParamHandle } from "../../types";
import { validateDefinition } from "../harness";
import { FmSynth, MAX_INDEX, midiToHz, operatorParamIds } from "./fmSynth";
import {
  ALGORITHMS,
  OPERATOR_COUNT,
  OUT,
  algorithmAt,
  buildOrder,
  diagramLayout,
  isCarrier,
} from "./operator/algorithms";
import {
  fakeServices,
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeGainNode,
  FakeOscillatorNode,
  type FakeAudioContext,
} from "./testing/fakeAudio";

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
    push(localId: string, value: number, when = 0): void {
      writers.get(localId)?.(value, when);
    },
    /** Bind and push in one go — most of this file only ever does both. */
    set(localId: string, value: number): void {
      this.bind(localId);
      this.push(localId, value);
    },
  };
}

function rig(): { ctx: FakeAudioContext; instance: DeviceInstance } {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  return { ctx, instance: FmSynth.create(asContext(ctx), io, fakeServices()) };
}

const oscillators = (ctx: FakeAudioContext): FakeOscillatorNode[] =>
  ctx.created.filter((n): n is FakeOscillatorNode => n instanceof FakeOscillatorNode);

/** The gain an oscillator's output runs through — its envelope. */
function envOf(osc: FakeOscillatorNode): FakeGainNode | undefined {
  return osc.connectedTo.find((n): n is FakeGainNode => n instanceof FakeGainNode);
}

/** Turn every operator on, so an algorithm's full shape is built. */
function allOperatorsOn(push: ReturnType<typeof paramPusher>): void {
  for (let op = 0; op < OPERATOR_COUNT; op++) push.set(operatorParamIds(op).on, 1);
}

describe("the algorithm table", () => {
  it("is structurally sound: eleven forests, A always audible", () => {
    expect(ALGORITHMS).toHaveLength(11);
    for (const algorithm of ALGORITHMS) {
      expect(algorithm.targets).toHaveLength(OPERATOR_COUNT);
      // A carrier in every one of them: an algorithm knob that can silence
      // the instrument is a broken knob.
      expect(isCarrier(algorithm, 0)).toBe(true);
      for (let op = 0; op < OPERATOR_COUNT; op++) {
        const target = algorithm.targets[op] ?? OUT;
        expect(target === OUT || (target >= 0 && target < OPERATOR_COUNT)).toBe(true);
        expect(target).not.toBe(op); // nothing modulates itself
      }
    }
  });

  it("has no duplicates — eleven DIFFERENT instruments", () => {
    const seen = new Set(ALGORITHMS.map((a) => a.targets.join(",")));
    expect(seen.size).toBe(ALGORITHMS.length);
  });

  // A cycle would be an operator wired into a frequency param that is itself
  // downstream of it: a feedback loop Web Audio refuses to schedule, and the
  // one class of table typo that would not show up as a wrong sound but as
  // no sound at all.
  it("contains no cycles, so every operator can be built in order", () => {
    for (const algorithm of ALGORITHMS) {
      const order = buildOrder(algorithm);
      expect([...order].sort()).toEqual([0, 1, 2, 3]);
      const built = new Set<number>();
      // Reverse order is the build order: a modulator's target must already
      // exist when the modulator is made.
      for (const op of [...order].reverse()) {
        const target = algorithm.targets[op] ?? OUT;
        if (target !== OUT) expect(built.has(target)).toBe(true);
        built.add(op);
      }
    }
  });

  it("clamps out-of-range algorithm values, because a param is a number", () => {
    expect(algorithmAt(-4)).toBe(ALGORITHMS[0]);
    expect(algorithmAt(99)).toBe(ALGORITHMS[ALGORITHMS.length - 1]);
    expect(algorithmAt(2.4)).toBe(ALGORITHMS[2]);
  });

  it("lays every operator out on its own spot, in every algorithm", () => {
    for (const algorithm of ALGORITHMS) {
      const { x, row } = diagramLayout(algorithm);
      const spots = new Set<string>();
      for (let op = 0; op < OPERATOR_COUNT; op++) spots.add(`${String(x[op])}:${String(row[op])}`);
      expect(spots.size).toBe(OPERATOR_COUNT);
      // Carriers sit on the bottom row; a modulator is always above what it
      // feeds, which is what makes the diagram readable as a signal path.
      for (let op = 0; op < OPERATOR_COUNT; op++) {
        const target = algorithm.targets[op] ?? OUT;
        if (target === OUT) expect(row[op]).toBe(0);
        else expect(row[op]).toBeGreaterThan(row[target] ?? 0);
      }
    }
  });
});

describe("core.fm (Operator)", () => {
  it("passes the harness's own validator", () => {
    expect(() => validateDefinition(FmSynth)).not.toThrow();
  });

  it("declares an integer coarse ratio and an integer fine offset", () => {
    const byId = new Map(FmSynth.params.map((d) => [d.id, d]));
    for (let op = 0; op < OPERATOR_COUNT; op++) {
      const ids = operatorParamIds(op);
      const coarse = byId.get(ids.coarse);
      const fine = byId.get(ids.fine);
      expect(coarse?.kind).toBe("stepped");
      expect(coarse?.step).toBe(1);
      expect([coarse?.min, coarse?.max]).toEqual([1, 32]);
      expect(fine?.kind).toBe("stepped");
      expect([fine?.min, fine?.max]).toEqual([0, 99]);
      // ...and the level too: Operator's levels are whole numbers.
      expect(byId.get(ids.level)?.kind).toBe("stepped");
    }
  });

  it("gives every operator its own four-stage envelope", () => {
    const ids = FmSynth.params.map((d) => d.id);
    for (let op = 0; op < OPERATOR_COUNT; op++) {
      const p = operatorParamIds(op);
      for (const id of [p.attack, p.decay, p.sustain, p.release]) expect(ids).toContain(id);
    }
  });

  it("runs each operator at an integer-plus-hundredths RATIO of the note", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set(operatorParamIds(1).coarse, 3);
    push.set(operatorParamIds(1).fine, 50); // 3.50

    instance.noteOn?.(69, 100, 0); // A4 = 440 Hz
    const hz = oscillators(ctx).map((o) => o.frequency.value);
    expect(hz).toContain(440); // A, ratio 1
    expect(hz.some((f) => Math.abs(f - 440 * 3.5) < 1e-6)).toBe(true);
  });

  // The claim that separates FM from an additive stack: a modulator's output
  // lands on another oscillator's `frequency` AudioParam.
  it("wires a modulator into its target's FREQUENCY, per the algorithm", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set("algorithm", 0); // D→C→B→A

    instance.noteOn?.(69, 100, 0);
    const oscs = oscillators(ctx);
    expect(oscs).toHaveLength(4);

    // One carrier reaching the output, three envelopes landing on a
    // frequency param — exactly the serial stack the label promises.
    const intoFrequency = ctx.created.filter(
      (n): n is FakeGainNode =>
        n instanceof FakeGainNode && n.connectedTo.some((t) => oscs.some((o) => o.frequency === t)),
    );
    expect(intoFrequency).toHaveLength(3);

    // ...and it really is a CHAIN, not three modulators on one carrier: each
    // of the three lands on a different oscillator.
    const targets = new Set(
      intoFrequency.map((g) => oscs.findIndex((o) => g.connectedTo.includes(o.frequency))),
    );
    expect(targets.size).toBe(3);
  });

  it("builds the additive algorithm with no frequency modulation at all", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set("algorithm", ALGORITHMS.length - 1); // A · B · C · D

    instance.noteOn?.(69, 100, 0);
    const oscs = oscillators(ctx);
    const intoFrequency = ctx.created.filter(
      (n) =>
        n instanceof FakeGainNode && n.connectedTo.some((t) => oscs.some((o) => o.frequency === t)),
    );
    expect(oscs).toHaveLength(4);
    expect(intoFrequency).toHaveLength(0);
  });

  // Deviation = index × the MODULATOR's own frequency (the textbook
  // definition). A fixed depth in Hz would make low notes dull and high ones
  // noise; scaling by the carrier instead would make the ratio knob change
  // brightness as a side effect.
  it("scales a modulator's depth by its OWN frequency", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set("algorithm", 7); // B→A · C · D — one modulator, unambiguous
    push.set(operatorParamIds(1).coarse, 2);
    push.set(operatorParamIds(1).level, 50);
    push.set(operatorParamIds(1).attack, 0);

    instance.noteOn?.(69, 127, 0); // 440 Hz, so B runs at 880 Hz
    const oscs = oscillators(ctx);
    const b = oscs.find((o) => Math.abs(o.frequency.value - 880) < 1e-6);
    expect(b).toBeDefined();
    const env = envOf(b!);
    // The ramp target is the peak: index 6 (level 50 of MAX_INDEX 12) × 880.
    const peak = env?.gain.events.find((e) => e.kind === "linear")?.value;
    expect(peak).toBeCloseTo(0.5 * MAX_INDEX * 880, 3);
  });

  it("an operator switched off is not built, and neither is what it fed", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set("algorithm", 0); // D→C→B→A
    push.set(operatorParamIds(1).on, 0); // B off

    instance.noteOn?.(60, 100, 0);
    // A sounds. B is off, so C (which modulates B) and D (which modulates C)
    // have nothing to reach — building them would be oscillators running
    // into a disconnected gain, burning CPU inaudibly.
    expect(oscillators(ctx)).toHaveLength(1);
  });

  it("makes no voice at all when every carrier is off", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set(operatorParamIds(0).on, 0); // A is the only carrier in algorithm 0

    instance.noteOn?.(60, 100, 0);
    expect(oscillators(ctx).filter((o) => o.startedAt !== null)).toHaveLength(0);
  });

  it("stops EVERY operator when a note is released", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set("algorithm", ALGORITHMS.length - 1); // four carriers

    instance.noteOn?.(60, 100, 0);
    instance.noteOff?.(60, 1);
    const oscs = oscillators(ctx);
    expect(oscs).toHaveLength(4);
    // A modulator left running is inaudible but never garbage-collected —
    // one leaked oscillator per operator per note.
    for (const osc of oscs) expect(osc.stoppedAt).not.toBeNull();
  });

  it("caps polyphony, stealing the oldest ringing voice", () => {
    const { ctx, instance } = rig();
    for (let i = 0; i < 20; i += 1) instance.noteOn?.(40 + i, 100, i * 0.01);
    const stopped = oscillators(ctx).filter((o) => o.stoppedAt !== null).length;
    expect(stopped).toBeGreaterThan(0);
  });

  it("velocity scales the carrier, not the modulation", () => {
    const loud = rig();
    const soft = rig();
    for (const { instance } of [loud, soft]) {
      const push = paramPusher(instance);
      allOperatorsOn(push);
      push.set("algorithm", 7); // B→A · C · D
    }
    loud.instance.noteOn?.(69, 127, 0);
    soft.instance.noteOn?.(69, 32, 0);

    const carrierPeak = (r: typeof loud): number => {
      const osc = oscillators(r.ctx).find((o) => Math.abs(o.frequency.value - 440) < 1e-6)!;
      return envOf(osc)?.gain.events.find((e) => e.kind === "linear")?.value ?? 0;
    };
    const modPeak = (r: typeof loud): number => {
      const osc = oscillators(r.ctx).find((o) => Math.abs(o.frequency.value - 880) < 1e-6)!;
      return envOf(osc)?.gain.events.find((e) => e.kind === "linear")?.value ?? 0;
    };
    expect(carrierPeak(soft)).toBeLessThan(carrierPeak(loud));
    // Brightness is the patch's, not the player's: velocity moving the
    // modulation index would make every soft note a different instrument.
    expect(modPeak(soft)).toBeCloseTo(modPeak(loud), 6);
  });

  it("keeps a patch sounding the same on every key", () => {
    const { ctx, instance } = rig();
    const push = paramPusher(instance);
    allOperatorsOn(push);
    push.set("algorithm", 7);
    push.set(operatorParamIds(1).coarse, 2);

    instance.noteOn?.(48, 100, 0);
    instance.noteOn?.(72, 100, 0.5);
    const oscs = oscillators(ctx);
    const low = midiToHz(48);
    const high = midiToHz(72);
    const ratioAt = (base: number): number => {
      const mod = oscs.find((o) => Math.abs(o.frequency.value - base * 2) < 1e-3);
      return (mod?.frequency.value ?? 0) / base;
    };
    expect(ratioAt(low)).toBeCloseTo(2, 6);
    expect(ratioAt(high)).toBeCloseTo(2, 6);
  });
});
