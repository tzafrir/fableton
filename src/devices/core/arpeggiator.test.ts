// `core.arpeggiator` — the live note effect. Entirely headless: it owns no
// audio nodes at all, so the "engine" it is tested against is a list of the
// notes it emitted.

import { describe, expect, it } from "vitest";
import type { DeviceInstance, NoteTarget, NoteWindow, ParamHandle } from "../../types";
import { PPQ } from "../../types";
import { validateDefinition } from "../harness";
import { ARP_MODE_LABELS, Arpeggiator, stepTick } from "./arpeggiator";
import { divisionIndex } from "./noteDivisions";
import { asContext, buildDeviceIO, createFakeAudioContext, fakeServices } from "./testing/fakeAudio";

interface Emitted {
  type: "on" | "off" | "panic";
  pitch: number;
  vel: number;
  when: number;
}

/** Seconds per tick at 120 bpm: a beat is 0.5 s, a beat is `PPQ` ticks. */
const PER_TICK = 0.5 / PPQ;

function rig() {
  const ctx = createFakeAudioContext();
  const { io } = buildDeviceIO(ctx);
  const instance: DeviceInstance = Arpeggiator.create(asContext(ctx), io, fakeServices());
  const out: Emitted[] = [];
  const target: NoteTarget = {
    noteOn: (pitch, vel, when) => out.push({ type: "on", pitch, vel, when }),
    noteOff: (pitch, when) => out.push({ type: "off", pitch, vel: 0, when }),
    allNotesOff: (when) => out.push({ type: "panic", pitch: -1, vel: 0, when }),
  };
  instance.setNoteOutput?.(target);

  // Params, pushed the way the registry pushes them.
  const writers = new Map<string, (value: number, when: number) => void>();
  for (const desc of Arpeggiator.params) {
    const handle = {
      desc,
      bindMessage: (write: (value: number, when: number) => void) => {
        writers.set(desc.id, write);
      },
      bindAudioParam: () => undefined,
    } as unknown as ParamHandle;
    instance.connectParam(desc.id, handle);
    // Every device is born holding its descriptor defaults.
    writers.get(desc.id)?.(desc.defaultValue, 0);
  }

  /** A window over `[fromTick, toTick)` on a straight 120 bpm tick line. */
  const fill = (fromTick: number, toTick: number): void => {
    const window: NoteWindow = {
      fromTick,
      toTick,
      ppq: PPQ,
      timeAt: (tick) => tick * PER_TICK,
    };
    instance.fillNotes?.(window);
  };

  return {
    instance,
    out,
    set: (id: string, value: number): void => {
      writers.get(id)?.(value, 0);
    },
    fill,
    ons: (): Emitted[] => out.filter((e) => e.type === "on"),
    pitches: (): number[] => out.filter((e) => e.type === "on").map((e) => e.pitch),
  };
}

/** Holds C-E-G from tick 0, all three note-ons landing before the first step. */
function holdCMajor(r: ReturnType<typeof rig>, when = -1): void {
  for (const pitch of [60, 64, 67]) r.instance.noteOn?.(pitch, 100, when);
}

describe("the definition", () => {
  it("passes the harness's own validator", () => {
    expect(() => validateDefinition(Arpeggiator)).not.toThrow();
  });

  it("is a midiEffect with no audio ports — it is not in the routing graph", () => {
    expect(Arpeggiator.kind).toBe("midiEffect");
    expect(Arpeggiator.audioIn).toEqual([]);
    expect(Arpeggiator.audioOut).toEqual([]);
  });

  it("labels one mode per shared order, plus Chord", () => {
    // The device's list is the transform's plus the one mode only a live arp
    // can offer; a mismatch here means the two would disagree on a chord.
    expect(ARP_MODE_LABELS).toHaveLength(7);
    expect(ARP_MODE_LABELS[6]).toBe("Chord");
  });
});

describe("stepTick — the swing grid", () => {
  it("leaves the down-beats alone whatever the swing", () => {
    for (const swing of [-50, 0, 25, 50]) {
      expect(stepTick(0, 240, swing)).toBe(0);
      expect(stepTick(2, 240, swing)).toBe(480);
    }
  });

  it("delays the off-beats, and rushes them for negative swing", () => {
    expect(stepTick(1, 240, 0)).toBe(240);
    expect(stepTick(1, 240, 50)).toBe(360);
    expect(stepTick(1, 240, -25)).toBe(180);
  });
});

describe("generating", () => {
  it("emits one note per step of the rate, in ascending order", () => {
    const r = rig();
    holdCMajor(r);
    // One beat at 1/16 is four steps.
    r.fill(0, PPQ);
    expect(r.pitches()).toEqual([60, 64, 67, 60]);
  });

  it("emits nothing at all with no chord held", () => {
    const r = rig();
    r.fill(0, PPQ);
    expect(r.out).toEqual([]);
  });

  it("puts each step exactly on its grid tick", () => {
    const r = rig();
    holdCMajor(r);
    r.fill(0, PPQ);
    const at = r.ons().map((e) => Math.round(e.when / PER_TICK));
    expect(at).toEqual([0, 240, 480, 720]);
  });

  it("follows the rate param — a 1/8 covers a beat in two steps", () => {
    const r = rig();
    r.set("rate", divisionIndex("1/8"));
    holdCMajor(r);
    r.fill(0, PPQ);
    expect(r.pitches()).toEqual([60, 64]);
  });

  it("walks down, and bounces without repeating the turning notes", () => {
    const down = rig();
    down.set("mode", 1);
    holdCMajor(down);
    down.fill(0, PPQ);
    expect(down.pitches()).toEqual([67, 64, 60, 67]);

    const upDown = rig();
    upDown.set("mode", 2);
    holdCMajor(upDown);
    upDown.fill(0, PPQ);
    // 60 64 67 64 — three pitches bounce in four steps, no doubled top.
    expect(upDown.pitches()).toEqual([60, 64, 67, 64]);
  });

  it("expands over octaves", () => {
    const r = rig();
    r.set("octaves", 2);
    holdCMajor(r);
    r.fill(0, PPQ * 2);
    expect(r.pitches().slice(0, 6)).toEqual([60, 64, 67, 72, 76, 79]);
  });

  it("plays the whole chord on every step in Chord mode", () => {
    const r = rig();
    r.set("mode", 6);
    holdCMajor(r);
    r.fill(0, 240);
    expect(r.pitches()).toEqual([60, 64, 67]);
    // One step, so they all land at the same moment.
    expect(new Set(r.ons().map((e) => e.when)).size).toBe(1);
  });

  it("keeps its place in the pattern when the chord changes under it (Retrigger off)", () => {
    const r = rig();
    r.set("retrigger", 0);
    holdCMajor(r);
    r.fill(0, 480); // steps 0 and 1 -> 60, 64
    // Swap the chord for D-F-A between step 1 and step 2.
    for (const pitch of [60, 64, 67]) r.instance.noteOff?.(pitch, 480 * PER_TICK - 0.001);
    for (const pitch of [62, 65, 69]) r.instance.noteOn?.(pitch, 100, 480 * PER_TICK - 0.001);
    r.fill(480, 960);
    // The pattern is at index 2 when the new chord arrives, so it carries on
    // at that chord's THIRD note — which is the whole point of playing an arp
    // over a progression.
    expect(r.pitches()).toEqual([60, 64, 69, 62]);
  });

  it("restarts the pattern on a new chord when Retrigger is on (the default)", () => {
    const r = rig();
    holdCMajor(r);
    r.fill(0, 480);
    for (const pitch of [60, 64, 67]) r.instance.noteOff?.(pitch, 480 * PER_TICK - 0.001);
    for (const pitch of [62, 65, 69]) r.instance.noteOn?.(pitch, 100, 480 * PER_TICK - 0.001);
    r.fill(480, 960);
    expect(r.pitches()).toEqual([60, 64, 62, 65]);
  });

  it("applies a chord change at the step it is due, not the window it arrives in", () => {
    const r = rig();
    holdCMajor(r);
    // A fourth note arriving in time for step 2 but not step 1.
    r.instance.noteOn?.(72, 100, 300 * PER_TICK);
    r.fill(0, PPQ);
    // Steps at 0 and 240 see a 3-note chord; 480 and 720 see a 4-note one, so
    // the pattern reaches 67 at step 2 and 72 at step 3.
    expect(r.pitches()).toEqual([60, 64, 67, 72]);
  });
});

describe("shaping", () => {
  it("sets the note length from the gate, as a fraction of the step", () => {
    const r = rig();
    r.set("gate", 50);
    holdCMajor(r);
    r.fill(0, 240);
    const on = r.out.find((e) => e.type === "on")!;
    const off = r.out.find((e) => e.type === "off")!;
    expect((off.when - on.when) / PER_TICK).toBeCloseTo(120, 3);
  });

  it("delays the off-beats by the swing", () => {
    const r = rig();
    r.set("swing", 50);
    holdCMajor(r);
    r.fill(0, 480);
    const at = r.ons().map((e) => Math.round(e.when / PER_TICK));
    expect(at).toEqual([0, 360]);
  });

  it("transposes what it plays without moving the grid", () => {
    const r = rig();
    r.set("transpose", 12);
    holdCMajor(r);
    r.fill(0, 480);
    expect(r.pitches()).toEqual([72, 76]);
  });

  it("scales velocity, and clamps it to a legal MIDI value", () => {
    const r = rig();
    r.set("velocity", 200);
    holdCMajor(r);
    r.fill(0, 240);
    expect(r.ons()[0]!.vel).toBe(127); // 100 * 2, clamped
  });

  it("drops a step whose transposed pitch leaves the MIDI range", () => {
    const r = rig();
    r.set("transpose", 24);
    r.instance.noteOn?.(120, 100, -1);
    r.fill(0, 240);
    expect(r.out).toEqual([]);
  });
});

describe("holding", () => {
  it("keeps running after the keys come up when Hold is on", () => {
    const r = rig();
    r.set("hold", 1);
    holdCMajor(r);
    r.fill(0, 240);
    for (const pitch of [60, 64, 67]) r.instance.noteOff?.(pitch, 240 * PER_TICK);
    r.fill(240, 960);
    expect(r.pitches()).toEqual([60, 64, 67, 60]);
  });

  it("replaces the latched chord when a new one starts, rather than adding to it", () => {
    const r = rig();
    r.set("hold", 1);
    holdCMajor(r);
    r.fill(0, 240);
    for (const pitch of [60, 64, 67]) r.instance.noteOff?.(pitch, 240 * PER_TICK);
    for (const pitch of [62, 65]) r.instance.noteOn?.(pitch, 100, 300 * PER_TICK);
    r.fill(240, 960);
    // Step 1 (tick 240) still belongs to the latched C major — the new keys
    // are not down until tick 300 — and the two after it are the new chord,
    // from the top of the pattern.
    expect(r.pitches()).toEqual([60, 64, 62, 65]);
  });

  it("stops when Hold is switched off with no keys down", () => {
    const r = rig();
    r.set("hold", 1);
    holdCMajor(r);
    r.fill(0, 240);
    for (const pitch of [60, 64, 67]) r.instance.noteOff?.(pitch, 240 * PER_TICK);
    r.set("hold", 0);
    r.fill(240, 960);
    expect(r.pitches()).toEqual([60]);
  });
});

describe("the transport's edges", () => {
  it("re-emits after the playhead jumps backwards (a loop wrap)", () => {
    const r = rig();
    holdCMajor(r);
    r.fill(0, 480);
    expect(r.pitches()).toHaveLength(2);
    // The brace wraps: the next window opens BEFORE the last one ended. A
    // step ledger that only moved forward would go silent here for good.
    r.fill(0, 480);
    expect(r.pitches()).toHaveLength(4);
  });

  it("does not emit the same step twice across contiguous windows", () => {
    const r = rig();
    holdCMajor(r);
    r.fill(0, 480);
    r.fill(480, 960);
    expect(r.ons().map((e) => Math.round(e.when / PER_TICK))).toEqual([0, 240, 480, 720]);
  });

  it("releases stragglers at their own onset on allNotesOff", () => {
    const r = rig();
    holdCMajor(r);
    r.fill(0, PPQ);
    r.out.length = 0;
    // Panic at the start of the window: every note-on it already handed out
    // is in the future and cannot be retracted, so each gets a note-off.
    r.instance.allNotesOff?.(0);
    const offs = r.out.filter((e) => e.type === "off");
    expect(offs).toHaveLength(4);
    expect(r.out.at(-1)!.type).toBe("panic");
  });

  it("goes quiet after a panic until something is held again", () => {
    const r = rig();
    holdCMajor(r);
    r.fill(0, 240);
    r.instance.allNotesOff?.(0);
    r.out.length = 0;
    r.fill(240, PPQ);
    expect(r.out).toEqual([]);
  });

  it("emits nothing at all with no output wired", () => {
    const ctx = createFakeAudioContext();
    const { io } = buildDeviceIO(ctx);
    const instance = Arpeggiator.create(asContext(ctx), io, fakeServices());
    instance.noteOn?.(60, 100, 0);
    expect(() =>
      instance.fillNotes?.({ fromTick: 0, toTick: PPQ, ppq: PPQ, timeAt: (t) => t * PER_TICK }),
    ).not.toThrow();
  });
});
