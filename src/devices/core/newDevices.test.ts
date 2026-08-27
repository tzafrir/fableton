// The instruments and effects added for song-writing: FM, kick, drum machine,
// overdrive and distortion. Everything here runs against the headless context
// stand-in (SS15: the load-bearing logic needs no browser).

import { describe, expect, it } from "vitest";
import type { DeviceInstance, ParamHandle } from "../../types";
import { validateDefinition } from "../harness";
import { FmSynth, midiToHz } from "./fmSynth";
import { Kick } from "./kick";
import { DrumMachine, PADS, padNoteName } from "./drumMachine";
import { Distortion, Overdrive, hardClip, postGainFor, softClip } from "./overdrive";
import {
  asContext,
  buildDeviceIO,
  createFakeAudioContext,
  FakeBufferSourceNode,
  FakeGainNode,
  FakeOscillatorNode,
  FakeWaveShaperNode,
  type FakeAudioContext,
} from "./testing/fakeAudio";

/** Drives a device's `connectParam` with a stub handle that just records the
 *  binding, then lets the test push values as the registry would. */
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
  };
}

function rig(definition: typeof FmSynth): { ctx: FakeAudioContext; instance: DeviceInstance } {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  return { ctx, instance: definition.create(asContext(ctx), io) };
}

const oscillators = (ctx: FakeAudioContext): FakeOscillatorNode[] =>
  ctx.created.filter((n): n is FakeOscillatorNode => n instanceof FakeOscillatorNode);
const sources = (ctx: FakeAudioContext): FakeBufferSourceNode[] =>
  ctx.created.filter((n): n is FakeBufferSourceNode => n instanceof FakeBufferSourceNode);

describe("every new definition is structurally valid", () => {
  it("passes the harness's own validator", () => {
    for (const def of [FmSynth, Kick, DrumMachine, Overdrive, Distortion]) {
      expect(() => validateDefinition(def)).not.toThrow();
    }
  });
});

describe("core.fm", () => {
  it("modulates the carrier's FREQUENCY, at a ratio of the played note", () => {
    const { ctx, instance } = rig(FmSynth);
    const push = paramPusher(instance);
    push.bind("ratio");
    push.push("ratio", 3);

    instance.noteOn?.(69, 100, 0); // A4 = 440 Hz
    const [carrier, modulator] = oscillators(ctx) as [FakeOscillatorNode, FakeOscillatorNode];
    expect(carrier.frequency.value).toBeCloseTo(440, 5);
    // The ratio is a RATIO: the modulator tracks the note, so the timbre is
    // the same on every key.
    expect(modulator.frequency.value).toBeCloseTo(1320, 5);

    // ...and the modulator's gain lands on the carrier's frequency param,
    // which is what makes this FM rather than two oscillators playing.
    const intoFrequency = ctx.created.some(
      (node) => node instanceof FakeGainNode && node.connectedTo.includes(carrier.frequency),
    );
    expect(intoFrequency).toBe(true);
  });

  it("scales the modulation depth by the carrier frequency", () => {
    const { ctx, instance } = rig(FmSynth);
    const push = paramPusher(instance);
    push.bind("index");
    push.push("index", 5);

    instance.noteOn?.(69, 127, 0);
    const carrier = oscillators(ctx)[0] as FakeOscillatorNode;
    const modGain = ctx.created.find(
      (n): n is FakeGainNode => n instanceof FakeGainNode && n.connectedTo.includes(carrier.frequency),
    );
    // index 5 at 440 Hz = 2200 Hz of deviation. A FIXED depth would turn high
    // notes to noise and leave low ones dull.
    expect(modGain?.gain.events[0]?.value).toBeCloseTo(2200, 3);
  });

  it("stops both oscillators when a note is released", () => {
    const { ctx, instance } = rig(FmSynth);
    instance.noteOn?.(60, 100, 0);
    instance.noteOff?.(60, 1);
    const [carrier, modulator] = oscillators(ctx) as [FakeOscillatorNode, FakeOscillatorNode];
    expect(carrier.stoppedAt).not.toBeNull();
    // A modulator left running is inaudible but never garbage-collected —
    // one leaked oscillator per note.
    expect(modulator.stoppedAt).toBe(carrier.stoppedAt);
  });

  it("caps polyphony, stealing the oldest ringing voice", () => {
    const { ctx, instance } = rig(FmSynth);
    for (let i = 0; i < 20; i += 1) instance.noteOn?.(40 + i, 100, i * 0.01);
    const stopped = oscillators(ctx).filter((o) => o.stoppedAt !== null).length;
    expect(stopped).toBeGreaterThan(0);
  });
});

describe("core.kick", () => {
  it("sweeps the pitch DOWN into the played note, exponentially", () => {
    const { ctx, instance } = rig(Kick);
    const push = paramPusher(instance);
    push.bind("sweep");
    push.bind("pitchDecay");
    push.push("sweep", 12);
    push.push("pitchDecay", 50);

    instance.noteOn?.(36, 127, 0); // C1
    const osc = oscillators(ctx)[0] as FakeOscillatorNode;
    const events = osc.frequency.events;
    const start = events[0];
    const ramp = events[1];
    expect(start?.value).toBeCloseTo(midiToHz(36) * 2, 3); // 12 semitones up
    expect(ramp?.kind).toBe("exponential");
    expect(ramp?.value).toBeCloseTo(midiToHz(36), 3);
    expect(ramp?.time).toBeCloseTo(0.05, 5);
  });

  it("is tuned by the NOTE, so it can be written as a melodic part", () => {
    const { ctx, instance } = rig(Kick);
    instance.noteOn?.(36, 127, 0);
    instance.noteOn?.(48, 127, 1); // an octave up
    const [low, high] = oscillators(ctx) as [FakeOscillatorNode, FakeOscillatorNode];
    const landed = (osc: FakeOscillatorNode): number => osc.frequency.events[1]?.value ?? 0;
    expect(landed(high) / landed(low)).toBeCloseTo(2, 5);
  });

  it("offsets the whole instrument by `tune`", () => {
    const { ctx, instance } = rig(Kick);
    const push = paramPusher(instance);
    push.bind("tune");
    push.push("tune", 12);
    instance.noteOn?.(36, 127, 0);
    const osc = oscillators(ctx)[0] as FakeOscillatorNode;
    expect(osc.frequency.events[1]?.value).toBeCloseTo(midiToHz(48), 3);
  });
});

describe("core.drum-machine", () => {
  it("maps its pads to distinct General MIDI notes", () => {
    const notes = PADS.map((pad) => pad.note);
    expect(new Set(notes).size).toBe(notes.length);
    expect(PADS.find((pad) => pad.engine === "kick")?.note).toBe(36);
    expect(padNoteName(36)).toBe("C1"); // the same numbering the key strip uses
  });

  it("declares three controls per pad, and a panel row per pad", () => {
    for (const pad of PADS) {
      for (const suffix of ["Tune", "Decay", "Level"]) {
        expect(DrumMachine.params.some((param) => param.id === `${pad.id}${suffix}`)).toBe(true);
      }
    }
    expect(DrumMachine.panel?.rows).toHaveLength(PADS.length);
    expect(DrumMachine.panel?.rows[0]?.label).toContain("Kick");
  });

  it("fires only the pad a note is mapped to, and stays silent off the map", () => {
    const { ctx, instance } = rig(DrumMachine);
    const before = ctx.created.length;
    instance.noteOn?.(36, 127, 0); // kick: an oscillator plus a click burst
    expect(oscillators(ctx).length).toBe(1);

    const afterKick = ctx.created.length;
    instance.noteOn?.(100, 127, 1); // nothing is mapped up there
    expect(ctx.created.length).toBe(afterKick);
    expect(afterKick).toBeGreaterThan(before);
  });

  it("uses noise for the noise-based pads and a tuned body for the snare", () => {
    const { ctx, instance } = rig(DrumMachine);
    instance.noteOn?.(42, 127, 0); // closed hat
    expect(sources(ctx).length).toBeGreaterThan(0);
    expect(oscillators(ctx).length).toBe(0);

    instance.noteOn?.(38, 127, 1); // snare: two body oscillators + noise
    expect(oscillators(ctx).length).toBe(2);
  });

  it("silences a pad whose level is at -inf", () => {
    const { ctx, instance } = rig(DrumMachine);
    const push = paramPusher(instance);
    push.bind("kickLevel");
    push.push("kickLevel", -60);
    instance.noteOn?.(36, 127, 0);
    const env = ctx.created.find(
      (n): n is FakeGainNode => n instanceof FakeGainNode && n.gain.events.some((e) => e.kind === "linear"),
    );
    expect(env?.gain.events.find((e) => e.kind === "linear")?.value).toBe(0);
  });
});

describe("clipping curves", () => {
  it("keeps unity slope at the origin, so dropping the device changes nothing", () => {
    // The trap this guards (documented in saturator.ts): normalising a curve
    // to reach ±1 at its endpoints hides a fixed boost in every small signal.
    for (const x of [0.001, 0.01, 0.05]) {
      expect(softClip(x) / x).toBeCloseTo(1, 2);
      expect(hardClip(x, 1) / x).toBeCloseTo(1, 2);
    }
  });

  it("is monotonic and bounded across the whole input domain", () => {
    let previous = -Infinity;
    for (let x = -1; x <= 1; x += 0.01) {
      const y = hardClip(x, 0.5);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
      previous = y;
    }
  });

  it("edge 0 IS the overdrive's curve; edge 1 has a hard corner", () => {
    expect(hardClip(0.5, 0)).toBeCloseTo(softClip(0.5), 10);
    // At edge 1 the curve is a straight line up to the ceiling and then flat.
    // The ceiling is the SOFT curve's own peak, so crossfading between the two
    // changes the shape without changing the output level.
    const ceiling = softClip(1);
    expect(hardClip(0.5, 1)).toBeCloseTo(0.5, 10); // straight, not curved
    expect(hardClip(0.9, 1)).toBeCloseTo(ceiling, 10); // and then a corner
    expect(hardClip(2, 1)).toBeCloseTo(ceiling, 10);
    // The soft curve never gets there: it is still bending at its own peak.
    expect(softClip(0.9)).toBeLessThan(ceiling);
  });

  it("compensates output so a drive sweep changes tone, not loudness", () => {
    const quiet = postGainFor(softClip, 0);
    const loud = postGainFor(softClip, 24);
    expect(loud).toBeLessThan(quiet); // more drive -> more make-down
    expect(postGainFor(() => 0, 12)).toBe(1); // never divides by a flat curve
  });
});

describe("the clipping devices", () => {
  it("rebuilds the curve for EDGE but not for drive", () => {
    const { ctx, instance } = rig(Distortion);
    const shaper = ctx.created.find((n): n is FakeWaveShaperNode => n instanceof FakeWaveShaperNode);
    const push = paramPusher(instance);
    push.bind("drive");
    push.bind("edge");

    const afterCreate = shaper?.curveWrites ?? 0;
    push.push("drive", 24);
    // A drive sweep must stay a plain AudioParam ramp: rebuilding a 2048-point
    // curve per frame of a knob drag is both a click and a stall.
    expect(shaper?.curveWrites).toBe(afterCreate);

    push.push("edge", 100);
    expect(shaper?.curveWrites).toBe(afterCreate + 1);
  });

  it("overdrive has no edge control at all — that is the difference", () => {
    expect(Overdrive.params.some((param) => param.id === "edge")).toBe(false);
    expect(Distortion.params.some((param) => param.id === "edge")).toBe(true);
  });
});
