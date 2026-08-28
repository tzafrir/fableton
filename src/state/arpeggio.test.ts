// The arpeggiator transform, head-on. No store, no editor, no audio.

import { describe, expect, it } from "vitest";
import { ARP_MODES, DEFAULT_ARP_OPTIONS, arpOrder, arpeggiate } from "./arpeggio";
import type { ArpOptions, ArpSource } from "./arpeggio";

const STEP = 240; // a 1/16 note at PPQ 960
const BAR = 3840;

/** A C-major triad held for one bar. */
const CHORD: readonly ArpSource[] = [
  { start: 0, dur: BAR, pitch: 60, vel: 100 },
  { start: 0, dur: BAR, pitch: 64, vel: 100 },
  { start: 0, dur: BAR, pitch: 67, vel: 100 },
];

function run(notes: readonly ArpSource[], options: Partial<ArpOptions> = {}) {
  return arpeggiate(notes, { ...DEFAULT_ARP_OPTIONS, ...options });
}

describe("arpOrder", () => {
  it("walks up, down, and bounces without repeating the turning notes", () => {
    // An up-down over three is 1 2 3 2, not 1 2 3 3 2 1 — the repeat is what
    // makes a bounced arp limp on every cycle.
    expect(arpOrder(3, "up")).toEqual([0, 1, 2]);
    expect(arpOrder(3, "down")).toEqual([2, 1, 0]);
    expect(arpOrder(3, "upDown")).toEqual([0, 1, 2, 1]);
    expect(arpOrder(3, "downUp")).toEqual([2, 1, 0, 1]);
  });

  it("degenerates safely for one and two voices", () => {
    expect(arpOrder(1, "upDown")).toEqual([0]);
    expect(arpOrder(2, "upDown")).toEqual([0, 1]);
    expect(arpOrder(0, "up")).toEqual([]);
  });

  it("has an order for every mode", () => {
    for (const mode of ARP_MODES) expect(arpOrder(3, mode).length).toBeGreaterThan(0);
  });
});

describe("arpeggiate", () => {
  it("fills the chord's span with one note per step", () => {
    const out = run(CHORD);
    expect(out).toHaveLength(BAR / STEP);
    expect(out.map((n) => n.start)).toEqual(
      Array.from({ length: BAR / STEP }, (_, i) => i * STEP),
    );
  });

  it("cycles the chord's pitches in the chosen order", () => {
    expect(run(CHORD).slice(0, 6).map((n) => n.pitch)).toEqual([60, 64, 67, 60, 64, 67]);
    expect(run(CHORD, { mode: "down" }).slice(0, 6).map((n) => n.pitch)).toEqual([
      67, 64, 60, 67, 64, 60,
    ]);
    expect(run(CHORD, { mode: "upDown" }).slice(0, 5).map((n) => n.pitch)).toEqual([
      60, 64, 67, 64, 60,
    ]);
  });

  it("expands over octaves", () => {
    expect(run(CHORD, { octaves: 2 }).slice(0, 7).map((n) => n.pitch)).toEqual([
      60, 64, 67, 72, 76, 79, 60,
    ]);
  });

  it("keeps its place across a chord CHANGE — the point of playing one over a progression", () => {
    const progression: ArpSource[] = [
      { start: 0, dur: STEP * 2, pitch: 60, vel: 100 },
      { start: 0, dur: STEP * 2, pitch: 64, vel: 100 },
      { start: STEP * 2, dur: STEP * 2, pitch: 65, vel: 100 },
      { start: STEP * 2, dur: STEP * 2, pitch: 69, vel: 100 },
    ];
    // Steps 0,1 walk the first chord; steps 2,3 continue the same index into
    // the second one rather than restarting.
    expect(run(progression).map((n) => n.pitch)).toEqual([60, 64, 65, 69]);
  });

  it("leaves gaps in the selection as gaps", () => {
    const gapped: ArpSource[] = [
      { start: 0, dur: STEP, pitch: 60, vel: 100 },
      { start: STEP * 4, dur: STEP, pitch: 64, vel: 100 },
    ];
    const out = run(gapped);
    expect(out.map((n) => n.start)).toEqual([0, STEP * 4]);
  });

  it("gates the note length, and never spills past the span", () => {
    expect(run(CHORD, { gate: 50 })[0]?.dur).toBe(STEP / 2);
    expect(run(CHORD, { gate: 100 })[0]?.dur).toBe(STEP);
    // Over 100% overlaps — a real arp sound — but the LAST note still stops
    // at the end of the span, or a re-run would grow the phrase each time.
    const legato = run(CHORD, { gate: 200 });
    const last = legato[legato.length - 1];
    expect(last!.start + last!.dur).toBeLessThanOrEqual(BAR);
  });

  it("carries each source note's velocity onto the steps it produces", () => {
    const dynamics: ArpSource[] = [
      { start: 0, dur: STEP * 2, pitch: 60, vel: 40 },
      { start: 0, dur: STEP * 2, pitch: 64, vel: 120 },
    ];
    expect(run(dynamics).map((n) => n.vel)).toEqual([40, 120]);
  });

  it("clamps generated pitches into MIDI range", () => {
    const high: ArpSource[] = [{ start: 0, dur: STEP, pitch: 120, vel: 100 }];
    expect(run(high, { octaves: 4 })[0]?.pitch).toBeLessThanOrEqual(127);
  });

  it("is deterministic in random mode when given a random source", () => {
    const options = { mode: "random" as const, random: () => 0.99 };
    expect(run(CHORD, options).slice(0, 3).map((n) => n.pitch)).toEqual([67, 67, 67]);
  });

  it("returns nothing for an empty selection or a zero-length one", () => {
    expect(run([])).toEqual([]);
    expect(run([{ start: 100, dur: 0, pitch: 60, vel: 100 }], { step: 240 })).toHaveLength(1);
  });

  it("survives a step of zero rather than looping forever", () => {
    expect(run(CHORD, { step: 0 }).length).toBe(BAR);
  });

  it("respects `asPlayed` order for a rolled chord", () => {
    const rolled: ArpSource[] = [
      { start: 0, dur: BAR, pitch: 67, vel: 100 },
      { start: 10, dur: BAR, pitch: 60, vel: 100 },
      { start: 20, dur: BAR, pitch: 64, vel: 100 },
    ];
    // At the first step only the top note is sounding; by the second, all
    // three are, in the order they arrived.
    expect(run(rolled, { mode: "asPlayed" }).slice(1, 4).map((n) => n.pitch)).toEqual([
      60, 64, 67,
    ]);
  });
});
