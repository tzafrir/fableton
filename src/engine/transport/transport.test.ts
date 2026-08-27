import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LoopRegion,
  MidiClip,
  NoteTarget,
  Seconds,
  TempoMap,
  Ticks,
  TransportState,
  WindowFiller,
} from "../../types";
import { DEFAULT_LOOKAHEAD_SECONDS, PPQ } from "../../types";
import { createFixedTempoMap, createTempoMap } from "../../time";
import { createClipEventSource } from "./clipEventSource";
import { createManualClock, type ManualClock } from "./manualClock";
import { createEngineTransport, type EngineTransport } from "./transport";

const BEAT = PPQ;
const BAR = 4 * PPQ;
/** At 120 bpm a beat is 0.5 s, so one bar is 2 s. */
const BPM = 120;
const START_LEAD = 0.005;
const STOP_EPS = 0.005;

/** Mutable stand-in for `BaseAudioContext` — the transport only ever reads
 *  `currentTime` from it, which is exactly SS12's point. */
interface FakeClockSource {
  currentTime: Seconds;
}

interface Call {
  kind: "on" | "off" | "all";
  pitch: number;
  vel: number;
  when: Seconds;
}

function makeTarget(): { target: NoteTarget; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    target: {
      noteOn: (pitch, vel, when) => calls.push({ kind: "on", pitch, vel, when }),
      noteOff: (pitch, when) => calls.push({ kind: "off", pitch, vel: 0, when }),
      allNotesOff: (when) => calls.push({ kind: "all", pitch: -1, vel: 0, when }),
    },
  };
}

function clip(notes: MidiClip["notes"], extra?: Partial<MidiClip>): MidiClip {
  return {
    id: "c1",
    trackId: "track-1",
    start: 0,
    length: BAR,
    notes,
    ...extra,
  };
}

interface Rig {
  ctx: FakeClockSource;
  clock: ManualClock;
  tempoMap: TempoMap;
  transport: EngineTransport;
  calls: Call[];
  /** Audio-clock time an event at `tick` should be scheduled for, given
   *  playback started at tick 0. */
  expectedTime(tick: Ticks): Seconds;
  /** Advances the audio clock to `seconds`, ticking the clock every 25 ms. */
  runTo(seconds: Seconds): void;
}

function makeRig(
  clips: readonly MidiClip[],
  extra?: {
    loop?: LoopRegion;
    lookAheadSeconds?: Seconds;
    /** Non-fixed maps exercise the piecewise conversion at the seam SS8 puts
     *  it at — `scheduleWindow` differences `secondsAt` across the window. */
    tempoMap?: TempoMap;
    /** Overrides the default single-target resolver (SS7 instrument swap). */
    resolveTarget?: (trackId: string) => NoteTarget | undefined;
  },
): Rig {
  const ctx: FakeClockSource = { currentTime: 0 };
  const clock = createManualClock();
  const tempoMap = extra?.tempoMap ?? createFixedTempoMap(BPM);
  const { target, calls } = makeTarget();
  const transport = createEngineTransport({
    context: ctx as unknown as BaseAudioContext,
    tempoMap,
    events: createClipEventSource(clips),
    resolveTarget:
      extra?.resolveTarget ??
      ((trackId) => (trackId === "track-1" ? target : undefined)),
    clock,
    ...(extra?.loop === undefined ? {} : { loop: extra.loop }),
    ...(extra?.lookAheadSeconds === undefined
      ? {}
      : { lookAheadSeconds: extra.lookAheadSeconds }),
  });

  return {
    ctx,
    clock,
    tempoMap,
    transport,
    calls,
    expectedTime: (tick) => START_LEAD + tempoMap.secondsAt(tick),
    runTo(seconds: Seconds): void {
      const stepMs = 25;
      const target0 = ctx.currentTime;
      const steps = Math.round(((seconds - target0) * 1000) / stepMs);
      for (let i = 1; i <= steps; i++) {
        ctx.currentTime = target0 + (i * stepMs) / 1000;
        clock.tick();
      }
    },
  };
}

let rig: Rig;

describe("transport — states", () => {
  beforeEach(() => {
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])]);
  });

  it("starts stopped at tick 0", () => {
    expect(rig.transport.state).toBe("stopped");
    expect(rig.transport.positionTicks()).toBe(0);
    expect(rig.transport.positionSeconds()).toBe(0);
  });

  it("play -> stop notifies subscribers and starts/stops the clock", () => {
    const seen: TransportState[] = [];
    const unsub = rig.transport.onStateChange((s) => seen.push(s));

    rig.transport.play();
    expect(rig.transport.state).toBe("playing");
    expect(rig.clock.running).toBe(true);
    expect(rig.clock.intervalMs).toBe(25);

    rig.transport.stop();
    expect(rig.transport.state).toBe("stopped");
    expect(rig.clock.running).toBe(false);
    expect(seen).toEqual(["playing", "stopped"]);

    unsub();
    rig.transport.play();
    expect(seen).toEqual(["playing", "stopped"]);
    rig.transport.dispose();
  });

  it("a listener that stops the transport during play() leaves no clock running", () => {
    // `setState` notifies synchronously, so `clock.stop()` can run before
    // `clock.start()` would — leaving a 40 Hz tick nothing ever cancels.
    const unsub = rig.transport.onStateChange((s) => {
      if (s === "playing") rig.transport.stop();
    });
    rig.transport.play(0);
    expect(rig.transport.state).toBe("stopped");
    expect(rig.clock.running).toBe(false);
    unsub();
    rig.transport.dispose();
  });

  it("record() is playing plus a capture flag", () => {
    rig.transport.record(BEAT);
    expect(rig.transport.state).toBe("recording");
    expect(rig.transport.positionTicks()).toBe(BEAT);
    rig.transport.stop();
    expect(rig.transport.state).toBe("stopped");
    rig.transport.dispose();
  });

  it("play() while playing is a no-op, and stop() while stopped is too", () => {
    rig.transport.play();
    const first = rig.calls.length;
    rig.transport.play();
    expect(rig.calls.length).toBe(first);
    rig.transport.stop();
    rig.transport.stop();
    rig.transport.dispose();
  });
});

describe("transport — scheduling", () => {
  it("schedules the first window immediately on play, with exact timestamps", () => {
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])]);
    rig.transport.play();

    expect(rig.calls).toHaveLength(2);
    expect(rig.calls[0]).toMatchObject({ kind: "on", pitch: 60, vel: 100 });
    expect(rig.calls[0]!.when).toBeCloseTo(rig.expectedTime(0), 9);
    expect(rig.calls[1]).toMatchObject({ kind: "off", pitch: 60 });
    expect(rig.calls[1]!.when).toBeCloseTo(rig.expectedTime(240), 9);
    rig.transport.dispose();
  });

  it("never schedules past the look-ahead horizon", () => {
    rig = makeRig([
      clip(
        Array.from({ length: 16 }, (_, i) => ({
          id: `n${String(i)}`,
          start: i * 240,
          dur: 120,
          pitch: 60 + i,
          vel: 100,
        })),
      ),
    ]);
    rig.transport.play();
    // Horizon is currentTime + 0.20 s; playback started 5 ms ahead of it.
    for (const call of rig.calls) {
      expect(call.when).toBeLessThanOrEqual(
        rig.ctx.currentTime + DEFAULT_LOOKAHEAD_SECONDS + 1e-9,
      );
    }
    expect(rig.calls.length).toBeGreaterThan(0);

    rig.runTo(2.0);
    // ... and as audio time advances, the rest land, each on its exact beat.
    const ons = rig.calls.filter((c) => c.kind === "on");
    expect(ons).toHaveLength(16);
    for (const [i, on] of ons.entries()) {
      expect(on.when).toBeCloseTo(rig.expectedTime(i * 240), 9);
      expect(on.pitch).toBe(60 + i);
    }
    rig.transport.dispose();
  });

  it("keeps windows contiguous and non-overlapping across ticks", () => {
    rig = makeRig([
      clip([
        { id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 },
        { id: "n2", start: BEAT, dur: 240, pitch: 62, vel: 100 },
        { id: "n3", start: 2 * BEAT, dur: 240, pitch: 64, vel: 100 },
      ]),
    ]);
    const windows: [Ticks, Ticks][] = [];
    const filler: WindowFiller = {
      fillWindow: (_h, from, to) => windows.push([from, to]),
    };
    rig.transport.addWindowFiller(filler);
    rig.transport.play();
    rig.runTo(2.0);

    expect(windows.length).toBeGreaterThan(5);
    expect(windows[0]![0]).toBe(0);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]![0]).toBe(windows[i - 1]![1]);
    }
    // Every note-on fired exactly once, in tick order.
    expect(rig.calls.filter((c) => c.kind === "on").map((c) => c.pitch)).toEqual([
      60, 62, 64,
    ]);
    rig.transport.dispose();
  });

  it("hands window fillers the horizon in audio-clock seconds", () => {
    rig = makeRig([clip([])]);
    const seen: { horizon: Seconds; from: Ticks; to: Ticks }[] = [];
    const unsub = rig.transport.addWindowFiller({
      fillWindow: (horizon, from, to) => seen.push({ horizon, from, to }),
    });
    rig.transport.play();
    const first = seen[0]!;
    const horizon = rig.ctx.currentTime + DEFAULT_LOOKAHEAD_SECONDS;
    // The window ends on an integer tick at or just before the horizon, so it
    // can fall short by up to half a tick (~0.26 ms at 120 bpm).
    expect(first.horizon).toBeLessThanOrEqual(horizon);
    expect(first.horizon).toBeGreaterThan(horizon - 0.001);
    expect(first.horizon).toBeCloseTo(rig.expectedTime(first.to), 9);
    expect(first.from).toBe(0);
    unsub();
    const count = seen.length;
    rig.runTo(0.5);
    expect(seen).toHaveLength(count);
    rig.transport.dispose();
  });

  it("reports which clock implementation is driving it", () => {
    rig = makeRig([clip([])]);
    // The injected clock here is the manual one; the shipped app injects
    // nothing and must get `"worker"` (SS12) — asserted against a real
    // browser in e2e/interaction/transport.spec.ts, which is the only place
    // a real `Worker` exists.
    expect(rig.transport.clockKind).toBe("manual");
    rig.transport.dispose();
  });

  it("recovers from dropped clock ticks without dropping events", () => {
    rig = makeRig([
      clip([
        { id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 },
        { id: "n2", start: 2 * BEAT, dur: 240, pitch: 64, vel: 100 },
      ]),
    ]);
    rig.transport.play();
    // A background tab stalls the worker: no ticks for 400 ms, then a tick
    // whose seq shows the gap.
    rig.ctx.currentTime = 0.4;
    rig.clock.tickDropping(15);
    expect(rig.transport.droppedTicks).toBeGreaterThan(0);
    rig.runTo(1.5);
    expect(rig.calls.filter((c) => c.kind === "on").map((c) => c.pitch)).toEqual([
      60, 64,
    ]);
    expect(rig.calls[0]!.when).toBeCloseTo(rig.expectedTime(0), 9);
    rig.transport.dispose();
  });

  it("ignores clips whose track resolves to no instrument", () => {
    rig = makeRig([
      clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }], {
        trackId: "not-wired",
      }),
    ]);
    rig.transport.play();
    rig.runTo(1.0);
    expect(rig.calls).toHaveLength(0);
    rig.transport.dispose();
  });
});

describe("transport — look-ahead floor", () => {
  it("plays in real time even when asked for a look-ahead shorter than a tick", () => {
    // Below one tick period the cursor cannot keep up: every tick would
    // schedule less music than elapsed and the re-anchor branch would discard
    // the difference, so playback would run slower than real time — silently.
    // The floor turns that into ordinary playback.
    const notes = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      start: i * (BEAT / 2),
      dur: 100,
      pitch: 60 + i,
      vel: 100,
    }));
    rig = makeRig([clip(notes, { length: BAR })], { lookAheadSeconds: 0.001 });
    rig.transport.play();
    rig.runTo(2.0);

    // All eight notes of the bar, at their real times — not a trickle.
    const ons = rig.calls.filter((c) => c.kind === "on");
    expect(ons).toHaveLength(8);
    for (const [i, on] of ons.entries()) {
      expect(on.when).toBeCloseTo(rig.expectedTime(i * (BEAT / 2)), 6);
    }
    expect(rig.transport.positionTicks()).toBeGreaterThan(rig.tempoMap.ticksAt(1.9));
    rig.transport.dispose();
  });
});

describe("transport — loop brace", () => {
  const loop: LoopRegion = { start: 0, end: 2 * BEAT, enabled: true };

  it("unrolls the transport loop, repeating the material", () => {
    rig = makeRig(
      [clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])],
      { loop },
    );
    rig.transport.play();
    rig.runTo(3.0);
    const ons = rig.calls.filter((c) => c.kind === "on");
    // One bar of loop = 2 beats = 1 s at 120 bpm.
    expect(ons.length).toBeGreaterThanOrEqual(3);
    for (const [i, on] of ons.entries()) {
      expect(on.when).toBeCloseTo(START_LEAD + i * 1.0, 6);
    }
    rig.transport.dispose();
  });

  it("wraps the reported position back to the loop start", () => {
    rig = makeRig([clip([])], { loop });
    rig.transport.play();
    rig.runTo(0.5);
    // Playback began 5 ms ahead of `currentTime`, so the playhead is exactly
    // that far behind the wall reading: 0.495 s = 950.4 -> 950 ticks.
    expect(rig.transport.positionTicks()).toBe(
      rig.tempoMap.ticksAt(0.5 - START_LEAD),
    );
    rig.runTo(1.25);
    // 1.25 s = 0.245 s past the wrap at 1.005 s -> ~470 ticks.
    expect(rig.transport.positionTicks()).toBeLessThan(BEAT);
    expect(rig.transport.positionTicks()).toBeGreaterThan(400);
    rig.transport.dispose();
  });

  it("plays straight through when the brace is disabled", () => {
    rig = makeRig(
      [clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])],
      { loop: { ...loop, enabled: false } },
    );
    rig.transport.play();
    rig.runTo(3.0);
    expect(rig.calls.filter((c) => c.kind === "on")).toHaveLength(1);
    rig.transport.dispose();
  });

  it("setLoop(null) takes effect from the next window", () => {
    rig = makeRig(
      [clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])],
      { loop },
    );
    rig.transport.play();
    rig.runTo(0.5);
    rig.transport.setLoop(null);
    rig.runTo(3.0);
    expect(rig.calls.filter((c) => c.kind === "on")).toHaveLength(1);
    rig.transport.dispose();
  });
});

describe("transport — loop brace edges", () => {
  it("wraps when the window boundary lands exactly on loop.end", () => {
    // `ticksAt` rounds, so a look-ahead boundary landing exactly on the brace
    // is an ordinary outcome (~1 pass in 48 for a 1-bar brace). Treating it as
    // "no wrap" parked the cursor on the brace and lost the loop for good.
    const tempoMap = createFixedTempoMap(BPM);
    const end = tempoMap.ticksAt(DEFAULT_LOOKAHEAD_SECONDS - START_LEAD);
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 100, pitch: 60, vel: 100 }])], {
      loop: { start: 0, end, enabled: true },
    });
    rig.transport.play();
    rig.runTo(2.0);
    const period = tempoMap.secondsAt(end);
    const ons = rig.calls.filter((c) => c.kind === "on");
    expect(ons.length).toBeGreaterThan(5); // it keeps looping, not runs away
    for (const [i, on] of ons.entries()) {
      expect(on.when).toBeCloseTo(START_LEAD + i * period, 6);
    }
    expect(rig.transport.positionTicks()).toBeLessThanOrEqual(end);
    rig.transport.dispose();
  });

  it("cuts a note held across the brace and re-triggers it on the next pass", () => {
    // The event source is half-open and playback never reaches the note's own
    // note-off tick, so the brace has to emit the cut — same rule the clip-loop
    // unroller applies at every repetition boundary (SS12).
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 4 * BEAT, pitch: 60, vel: 100 }])], {
      loop: { start: 0, end: 2 * BEAT, enabled: true },
    });
    rig.transport.play();
    rig.runTo(2.5);
    const notes = rig.calls.filter((c) => c.kind !== "all");
    // on at 0.005, then cut/re-trigger at every 1 s brace.
    expect(notes.slice(0, 5).map((c) => c.kind)).toEqual(["on", "off", "on", "off", "on"]);
    expect(notes[1]!.when).toBeCloseTo(START_LEAD + 1.0, 6);
    expect(notes[2]!.when).toBeCloseTo(START_LEAD + 1.0, 6); // cut, then re-attack
    expect(notes[3]!.when).toBeCloseTo(START_LEAD + 2.0, 6);
    rig.transport.dispose();
  });
});

describe("transport — a very short brace", () => {
  it("keeps looping and reporting a sane position past the anchor ring's capacity", () => {
    // MAX_PASSES_PER_TICK is 64 and the pass ring holds 256, so a few seconds
    // of a two-tick brace runs the ring right around. The oldest pass is
    // dropped rather than overwriting a live one, and the playhead stays
    // inside the brace throughout.
    const loop = { start: 0, end: 2, enabled: true };
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 1, pitch: 60, vel: 100 }])], { loop });
    rig.transport.play();
    for (let step = 1; step <= 200; step++) {
      rig.ctx.currentTime = step * 0.025;
      rig.clock.tick();
      const tick = rig.transport.positionTicks();
      expect(tick).toBeGreaterThanOrEqual(loop.start);
      expect(tick).toBeLessThanOrEqual(loop.end);
    }
    expect(rig.calls.filter((c) => c.kind === "on").length).toBeGreaterThan(256);
    rig.transport.dispose();
  });
});

describe("transport — main-thread stalls", () => {
  it("re-anchors instead of dumping a backlog of past timestamps", () => {
    rig = makeRig([
      clip(
        Array.from({ length: 16 }, (_, i) => ({
          id: `n${i}`,
          start: i * (BEAT / 4),
          dur: 100,
          pitch: 60 + i,
          vel: 100,
        })),
      ),
    ]);
    rig.transport.play();
    rig.runTo(0.1);
    rig.calls.length = 0;
    // The main thread was blocked for 2 s — ten look-ahead windows.
    rig.ctx.currentTime = 2.1;
    rig.clock.tick();
    expect(rig.calls.length).toBeGreaterThan(0);
    for (const call of rig.calls) {
      expect(call.when).toBeGreaterThanOrEqual(2.1); // nothing lands in the past
    }
    rig.transport.dispose();
  });

  it("releases a note that was sounding when the stall began", () => {
    // The re-anchor moves the timeline forward by the stall; a note already
    // handed to the instrument would otherwise hold until its note-off, which
    // moved with it — an unbounded drone (SS12: the stall path is what the
    // 25 ms worker clock exists to survive). The brace cuts held notes at a
    // tick discontinuity; this is the same cut at a TIME discontinuity.
    rig = makeRig([
      clip([{ id: "n1", start: 0, dur: 2 * BEAT, pitch: 60, vel: 100 }], {
        length: 8 * BAR,
      }),
    ]);
    rig.transport.play();
    rig.runTo(0.1);
    expect(rig.calls.filter((c) => c.kind === "off")).toHaveLength(0); // still held

    rig.ctx.currentTime = 2.1; // two seconds of main-thread stall
    rig.clock.tick();

    const off = rig.calls.find((c) => c.kind === "off" && c.pitch === 60);
    expect(off).toBeDefined();
    // Released at the re-anchor, not a stall-length later.
    expect(off!.when).toBeCloseTo(2.1 + START_LEAD, 6);
    rig.transport.dispose();
  });

  it("parks the playhead at the last scheduled tick until the new pass starts", () => {
    // The stall closed the old pass at the cursor and opened a new one that
    // begins slightly in the future. Reading the playhead in between must
    // report the end of what was actually scheduled, not extrapolate the
    // elapsed wall time into ticks nothing was ever scheduled for.
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 100, pitch: 60, vel: 100 }])]);
    rig.transport.play();
    rig.runTo(0.1);
    const beforeStall = rig.transport.positionTicks();

    rig.ctx.currentTime = 2.1; // two seconds of main-thread stall
    rig.clock.tick();

    const parked = rig.transport.positionTicks();
    expect(parked).toBeGreaterThanOrEqual(beforeStall);
    // Whatever the first window reached — nowhere near 2.1 s of music.
    expect(parked).toBeLessThan(rig.tempoMap.ticksAt(0.5));
    expect(rig.transport.positionSeconds()).toBeLessThan(0.5);

    // ...and playback resumes from there once the new pass is under way.
    rig.ctx.currentTime = 2.3;
    rig.clock.tick();
    expect(rig.transport.positionTicks()).toBeGreaterThan(parked);
    rig.transport.dispose();
  });
});

describe("transport — integer ticks at the entry points (SS8)", () => {
  it("rounds a fractional tick handed to play() and seek()", () => {
    // SS8: a tick is ALWAYS an integer. Everything downstream — `secondsAt`,
    // the anchor ring, the cursor — assumes it, and the dev-mode guard throws
    // on a fractional one, so the entry points normalize rather than trusting
    // the caller.
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])]);
    rig.transport.play(100.6);
    expect(rig.transport.positionTicks()).toBe(101);

    rig.transport.seek(BEAT + 0.4);
    expect(rig.transport.positionTicks()).toBe(BEAT);
    rig.transport.stop();

    // ...and while stopped, seek parks an integer too.
    rig.transport.seek(7.5);
    expect(rig.transport.positionTicks()).toBe(8);
    rig.transport.dispose();
  });

  it("rounds a fractional loop brace instead of throwing mid-tick", () => {
    // The brace goes straight into `secondsAt`/`closeLastAnchor`/`pushAnchor`
    // from inside the clock subscriber, where a throw would kill playback with
    // no recovery path (and in a production build, where the guard is compiled
    // out, would quietly seed fractional ticks into the cursor instead).
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 100, pitch: 60, vel: 100 }])], {
      loop: { start: 0.4, end: 2 * BEAT + 0.4, enabled: true },
    });
    rig.transport.play();
    expect(() => {
      rig.runTo(3);
    }).not.toThrow();
    expect(Number.isInteger(rig.transport.positionTicks())).toBe(true);
    expect(rig.transport.positionTicks()).toBeLessThanOrEqual(2 * BEAT);

    rig.transport.setLoop({ start: 0, end: BEAT + 0.6, enabled: true });
    expect(() => {
      rig.runTo(5);
    }).not.toThrow();
    expect(rig.transport.positionTicks()).toBeLessThanOrEqual(BEAT + 1);
    rig.transport.dispose();
  });
});

describe("transport — re-entrancy from a window filler", () => {
  it("stops scheduling immediately when a filler stops the transport", () => {
    // `addWindowFiller` is caller code (SS11's automation sampler) running
    // INSIDE the scheduling loop. If it stops the transport, the panic has
    // already gone out, so any further note-on would be posted behind it and
    // ring for up to a whole look-ahead while `state` reads "stopped".
    rig = makeRig(
      [
        clip(
          Array.from({ length: 32 }, (_, i) => ({
            id: `n${String(i)}`,
            start: i * (BEAT / 4),
            dur: 100,
            pitch: 60,
            vel: 100,
          })),
          { length: 8 * BAR },
        ),
      ],
      { loop: { start: 0, end: 2 * BEAT, enabled: true }, lookAheadSeconds: 3 },
    );
    let stopped = false;
    const filler: WindowFiller = {
      fillWindow: () => {
        if (stopped) return;
        stopped = true;
        rig.transport.stop();
      },
    };
    const unsub = rig.transport.addWindowFiller(filler);

    rig.transport.play(0);
    expect(rig.transport.state).toBe("stopped");

    const panicAt = rig.calls.findIndex((c) => c.kind === "all");
    expect(panicAt).toBeGreaterThanOrEqual(0);
    expect(rig.calls.slice(panicAt).filter((c) => c.kind === "on")).toHaveLength(0);

    unsub();
    rig.transport.dispose();
  });
});

describe("transport — position", () => {
  it("maps currentTime back through the tempo map while playing", () => {
    rig = makeRig([clip([])]);
    rig.transport.play();
    rig.ctx.currentTime = 0.505;
    // 0.5 s of playback at 120 bpm = one beat.
    expect(rig.transport.positionTicks()).toBe(BEAT);
    expect(rig.transport.positionSeconds()).toBeCloseTo(0.5, 9);
    rig.transport.dispose();
  });

  it("play(fromTick) starts there and stop() parks back at the start point", () => {
    rig = makeRig([clip([])]);
    rig.transport.play(2 * BEAT);
    expect(rig.transport.positionTicks()).toBe(2 * BEAT);
    rig.runTo(0.5);
    expect(rig.transport.positionTicks()).toBeGreaterThan(2 * BEAT);
    rig.transport.stop();
    expect(rig.transport.positionTicks()).toBe(2 * BEAT);
    rig.transport.dispose();
  });

  it("seek moves the playhead while stopped and while playing", () => {
    rig = makeRig([clip([])]);
    rig.transport.seek(3 * BEAT);
    expect(rig.transport.positionTicks()).toBe(3 * BEAT);
    rig.transport.play();
    rig.runTo(0.25);
    rig.transport.seek(0);
    expect(rig.transport.positionTicks()).toBe(0);
    rig.transport.stop();
    expect(rig.transport.positionTicks()).toBe(0);
    rig.transport.dispose();
  });

  it("re-schedules from the seek point while playing", () => {
    rig = makeRig([
      clip([
        { id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 },
        { id: "n2", start: 3 * BEAT, dur: 240, pitch: 72, vel: 100 },
      ]),
    ]);
    rig.transport.play();
    rig.ctx.currentTime = 0.1;
    rig.transport.seek(3 * BEAT);
    rig.runTo(0.4);
    expect(rig.calls.some((c) => c.kind === "on" && c.pitch === 72)).toBe(true);
    rig.transport.dispose();
  });
});

describe("transport — stop is silent", () => {
  it("sends allNotesOff(now + epsilon) to every track it played", () => {
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])]);
    rig.transport.play();
    rig.runTo(0.5);
    rig.calls.length = 0;
    rig.transport.stop();
    const panics = rig.calls.filter((c) => c.kind === "all");
    expect(panics).toHaveLength(1);
    expect(panics[0]!.when).toBeCloseTo(0.5 + STOP_EPS, 9);
    rig.transport.dispose();
  });

  it("releases note-ons that were already scheduled inside the horizon", () => {
    // The note-on at tick 1920 lands at t = 1.005 s; at t = 0.9 it is already
    // in the audio thread's future and cannot be retracted, so stop() must
    // release it at its own onset.
    rig = makeRig([
      clip([{ id: "n1", start: 2 * BEAT, dur: 4 * BEAT, pitch: 60, vel: 100 }]),
    ]);
    rig.transport.play();
    rig.runTo(0.9);
    const onCall = rig.calls.find((c) => c.kind === "on");
    expect(onCall).toBeDefined();
    rig.calls.length = 0;
    rig.transport.stop();
    const offs = rig.calls.filter((c) => c.kind === "off");
    expect(offs).toHaveLength(1);
    expect(offs[0]!.pitch).toBe(60);
    expect(offs[0]!.when).toBeCloseTo(onCall!.when + STOP_EPS, 9);
    rig.transport.dispose();
  });

  it("does not touch notes that already finished", () => {
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])]);
    rig.transport.play();
    rig.runTo(1.0);
    rig.calls.length = 0;
    rig.transport.stop();
    expect(rig.calls.filter((c) => c.kind === "off")).toHaveLength(0);
    rig.transport.dispose();
  });

  it("stops scheduling once stopped", () => {
    rig = makeRig([
      clip([{ id: "n1", start: 4 * BEAT, dur: 240, pitch: 60, vel: 100 }]),
    ]);
    rig.transport.play();
    rig.transport.stop();
    rig.calls.length = 0;
    rig.runTo(3.0);
    expect(rig.calls).toHaveLength(0);
    rig.transport.dispose();
  });
});

describe("transport — tempo", () => {
  it("setTempoMap keeps the position and re-schedules at the new rate", () => {
    rig = makeRig([
      clip([{ id: "n1", start: 2 * BEAT, dur: 240, pitch: 60, vel: 100 }]),
    ]);
    rig.transport.play();
    rig.ctx.currentTime = 0.1;
    const before = rig.transport.positionTicks();
    rig.transport.setTempoMap(createFixedTempoMap(240));
    expect(rig.transport.tempoMap.bpmAt(0)).toBe(240);
    expect(rig.transport.positionTicks()).toBe(before);
    rig.calls.length = 0;
    rig.runTo(1.0);
    const on = rig.calls.find((c) => c.kind === "on");
    expect(on).toBeDefined();
    // Two beats at 240 bpm = 0.5 s from the tempo change, not 1 s.
    const remaining = (2 * BEAT - before) / PPQ / 4; // quarter notes -> seconds
    expect(on!.when).toBeCloseTo(0.1 + START_LEAD + remaining, 6);
    rig.transport.dispose();
  });
});

describe("transport — lifecycle", () => {
  it("dispose stops playback and releases the clock", () => {
    rig = makeRig([clip([])]);
    const spy = vi.spyOn(rig.clock, "dispose");
    rig.transport.play();
    rig.transport.dispose();
    expect(rig.transport.state).toBe("stopped");
    expect(rig.clock.running).toBe(false);
    // The clock was injected, so the transport must not dispose it.
    expect(spy).not.toHaveBeenCalled();
  });

  it("window fillers stop being called after dispose", () => {
    rig = makeRig([clip([])]);
    let count = 0;
    rig.transport.addWindowFiller({
      fillWindow: () => {
        count++;
      },
    });
    rig.transport.play();
    const seen = count;
    expect(seen).toBeGreaterThan(0);
    rig.transport.dispose();
    rig.runTo(1.0);
    expect(count).toBe(seen);
  });
});

describe("transport — the sounding-note ledger", () => {
  it("cuts BOTH of two overlapping same-pitch notes at the brace", () => {
    // Nothing in `MidiClip` forbids two notes of one pitch overlapping on one
    // track, and M1's piano roll lets a user draw them. A ledger keyed only by
    // (pitch, track) would clear on the first note-off and leave the second
    // note held with nothing to release it at the brace — sustaining forever,
    // which is the exact failure this bookkeeping exists to prevent (SS12).
    rig = makeRig(
      [
        clip(
          [
            { id: "a", start: 0, dur: 1200, pitch: 60, vel: 100 },
            { id: "b", start: 900, dur: 2000, pitch: 60, vel: 100 },
          ],
          { length: 2 * BAR },
        ),
      ],
      { loop: { start: 0, end: 2 * BEAT, enabled: true } },
    );
    rig.transport.play();
    rig.runTo(1.6);

    const notes = rig.calls.filter((c) => c.kind !== "all");
    // on(a) · on(b) · off(a) · off(b)@brace · on(a) again on the next pass.
    expect(notes.slice(0, 5).map((c) => c.kind)).toEqual(["on", "on", "off", "off", "on"]);
    expect(notes[3]!.when).toBeCloseTo(START_LEAD + 1.0, 6); // the brace cut
    expect(notes[4]!.when).toBeCloseTo(START_LEAD + 1.0, 6);
    rig.transport.dispose();
  });

  it("falls back to allNotesOff when more notes are held than the ring can track", () => {
    // SOUNDING_CAPACITY is 512; past it the brace cannot know what is held, so
    // it broadcasts instead of leaking a stuck note.
    const notes = Array.from({ length: 600 }, (_, i) => ({
      id: `n${i}`,
      start: i,
      dur: 4 * BAR,
      pitch: i % 128,
      vel: 100,
    }));
    rig = makeRig([clip(notes, { length: 4 * BAR })], {
      loop: { start: 0, end: 2 * BEAT, enabled: true },
    });
    rig.transport.play();
    rig.runTo(1.2);
    const panics = rig.calls.filter((c) => c.kind === "all");
    expect(panics.length).toBeGreaterThanOrEqual(1);
    expect(panics[0]!.when).toBeCloseTo(START_LEAD + 1.0, 6);
    rig.transport.dispose();
  });
});

describe("transport — per-tick target resolution (SS7 instrument swap)", () => {
  it("re-resolves the track's instrument on every tick", () => {
    // The device behind a track can be swapped between ticks, so the
    // per-event target cache must not survive one.
    const first = makeTarget();
    const second = makeTarget();
    let current = first;
    rig = makeRig(
      [
        clip(
          [
            { id: "n1", start: 0, dur: 100, pitch: 60, vel: 100 },
            { id: "n2", start: 3 * BEAT, dur: 100, pitch: 62, vel: 100 },
          ],
          { length: BAR },
        ),
      ],
      { resolveTarget: () => current.target },
    );
    rig.transport.play();
    rig.runTo(0.1);
    expect(first.calls.filter((c) => c.kind === "on")).toHaveLength(1);

    current = second; // the user dropped a different instrument on the track
    rig.runTo(2.0);
    expect(second.calls.filter((c) => c.kind === "on" && c.pitch === 62)).toHaveLength(1);
    expect(first.calls.filter((c) => c.pitch === 62)).toHaveLength(0);
    rig.transport.dispose();
  });
});

describe("transport — pending-note overflow", () => {
  it("stop() broadcasts past the horizon when the pending ring overflowed", () => {
    // PENDING_CAPACITY is 1024 note-ons. Past that, stop() cannot release each
    // scheduled note individually, so it adds a second allNotesOff beyond the
    // look-ahead horizon — SS12's "stop is silent", belt and braces.
    const notes = Array.from({ length: 1200 }, (_, i) => ({
      id: `n${i}`,
      start: i * 2,
      dur: 100,
      pitch: 60,
      vel: 100,
    }));
    const lookAheadSeconds = 8;
    rig = makeRig([clip(notes, { length: 8 * BAR })], { lookAheadSeconds });
    rig.transport.play();
    expect(rig.calls.filter((c) => c.kind === "on").length).toBeGreaterThan(1024);

    rig.calls.length = 0;
    rig.transport.stop();
    const panics = rig.calls.filter((c) => c.kind === "all");
    expect(panics).toHaveLength(2);
    expect(panics[0]!.when).toBeCloseTo(STOP_EPS, 9);
    expect(panics[1]!.when).toBeCloseTo(STOP_EPS + lookAheadSeconds, 9);
    rig.transport.dispose();
  });
});

describe("transport — the pending ring stays bounded", () => {
  it("prunes elapsed note-ons so a long playback never trips the overflow", () => {
    // The pending ring holds scheduled-but-not-yet-sounded note-ons so `stop()`
    // can release each one individually. Entries whose onset has passed are no
    // longer pending, and pruning them on every tick is what keeps the ring
    // under PENDING_CAPACITY (1024): without it a continuous playback fills it
    // in a few seconds and silently degrades every later stop into the
    // broadcast fallback this ledger exists to avoid.
    const notes = Array.from({ length: 4000 }, (_, i) => ({
      id: `n${String(i)}`,
      start: i * 2,
      dur: 1,
      pitch: 60,
      vel: 100,
    }));
    rig = makeRig([clip(notes, { length: 16 * BAR })]);
    rig.transport.play();
    rig.runTo(3); // ~2900 note-ons scheduled, at most ~200 pending at a time
    expect(rig.calls.filter((c) => c.kind === "on").length).toBeGreaterThan(1024);

    rig.calls.length = 0;
    rig.transport.stop();
    expect(rig.calls.filter((c) => c.kind === "all")).toHaveLength(1);
    rig.transport.dispose();
  });
});

describe("transport — position clamps", () => {
  it("keeps the playhead inside the brace at every instant, not just at ticks", () => {
    // The playhead is read at rAF, i.e. at arbitrary times between clock ticks
    // and between look-ahead windows (SS12: "The playhead is UI-only"). It must
    // never read past the brace of the pass it is in — a rounded `ticksAt` one
    // tick beyond the end would otherwise draw the playhead outside the loop.
    const loopEnd = 2 * BEAT;
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 100, pitch: 60, vel: 100 }])], {
      loop: { start: 0, end: loopEnd, enabled: true },
    });
    const endSeconds = rig.tempoMap.secondsAt(loopEnd);
    rig.transport.play();

    for (let step = 1; step <= 400; step++) {
      rig.ctx.currentTime = step * 0.005;
      if (step % 5 === 0) rig.clock.tick();
      const tick = rig.transport.positionTicks();
      expect(tick).toBeGreaterThanOrEqual(0);
      expect(tick).toBeLessThanOrEqual(loopEnd);
      expect(rig.transport.positionSeconds()).toBeLessThanOrEqual(endSeconds + 1e-9);
    }
    rig.transport.dispose();
  });
});

describe("transport — tempo map with several segments (SS8)", () => {
  it("schedules across a tempo change inside one look-ahead window", () => {
    // The scheduler times every event as a `secondsAt` difference across the
    // window, so a tempo boundary falling INSIDE a window is the piecewise
    // integration path — the seam SS8 says the conversion lives at.
    const tempoMap = createTempoMap([
      { startTick: 0, bpm: 120 }, // 1 beat = 0.5 s
      { startTick: 2 * BEAT, bpm: 60 }, // 1 beat = 1.0 s
    ]);
    rig = makeRig(
      [
        clip(
          [
            { id: "n1", start: 0, dur: 100, pitch: 60, vel: 100 },
            { id: "n2", start: BEAT, dur: 100, pitch: 62, vel: 100 },
            { id: "n3", start: 2 * BEAT, dur: 100, pitch: 64, vel: 100 },
            { id: "n4", start: 3 * BEAT, dur: 100, pitch: 65, vel: 100 },
          ],
          { length: BAR },
        ),
      ],
      { tempoMap, lookAheadSeconds: 5 }, // the whole clip in the first window
    );
    rig.transport.play();

    const ons = rig.calls.filter((c) => c.kind === "on");
    expect(ons.map((c) => c.pitch)).toEqual([60, 62, 64, 65]);
    // 0 s, 0.5 s (at 120), then 1.0 s and 2.0 s (at 60) — not 1.5 s.
    expect(ons[0]!.when).toBeCloseTo(START_LEAD + 0, 6);
    expect(ons[1]!.when).toBeCloseTo(START_LEAD + 0.5, 6);
    expect(ons[2]!.when).toBeCloseTo(START_LEAD + 1.0, 6);
    expect(ons[3]!.when).toBeCloseTo(START_LEAD + 2.0, 6);
    rig.transport.dispose();
  });

  it("maps the playhead back through the same piecewise map", () => {
    const tempoMap = createTempoMap([
      { startTick: 0, bpm: 120 },
      { startTick: 2 * BEAT, bpm: 60 },
    ]);
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 100, pitch: 60, vel: 100 }])], {
      tempoMap,
    });
    rig.transport.play();
    rig.runTo(2.0); // playback started at START_LEAD, so 1.995 s of song
    expect(rig.transport.positionTicks()).toBe(tempoMap.ticksAt(2.0 - START_LEAD));
    // Past the tempo change, and slower than the fixed-120 map would give.
    expect(rig.transport.positionTicks()).toBeGreaterThan(2 * BEAT);
    expect(rig.transport.positionTicks()).toBeLessThan(
      createFixedTempoMap(BPM).ticksAt(1.995),
    );
    rig.transport.dispose();
  });
});

/**
 * Walks a call stream and returns the number of note-offs that arrived with
 * no matching note-on for that pitch — the pairing the `NoteTarget` contract
 * promises, and the thing an instrument that voices overlapping same-pitch
 * notes separately (`VoiceAllocator`, SS7) needs to keep a live voice alive.
 * `allNotesOff` clears the held set, exactly as the instrument does.
 */
function orphanOffCount(calls: readonly Call[]): number {
  const held = new Map<number, number>();
  let orphans = 0;
  for (const call of calls) {
    if (call.kind === "on") {
      held.set(call.pitch, (held.get(call.pitch) ?? 0) + 1);
    } else if (call.kind === "off") {
      const n = held.get(call.pitch) ?? 0;
      if (n === 0) orphans++;
      else held.set(call.pitch, n - 1);
    } else {
      held.clear();
    }
  }
  return orphans;
}

describe("transport — discontinuities never emit an unpaired note-off", () => {
  /** Two overlapping notes of ONE pitch — allowed by `MidiClip` and drawn by
   *  M1's piano roll, and the case where an unpaired note-off is audible: it
   *  releases the OTHER note's live voice. */
  const overlappingSamePitch = [
    { id: "a", start: 0, dur: 4 * BEAT, pitch: 60, vel: 100 },
    { id: "b", start: 2 * BEAT, dur: 4 * BEAT, pitch: 60, vel: 100 },
  ];

  it("suppresses them after a seek that lands exactly on the last window's end", () => {
    // The source cannot infer "this is a jump" from the ticks alone: this seek
    // target IS the previous window's `toTick`, so the window looks contiguous
    // while `seek` has already panicked everything the previous pass held.
    rig = makeRig([clip(overlappingSamePitch, { length: 8 * BEAT })]);
    rig.transport.play(0);
    const windowEnd = rig.tempoMap.ticksAt(DEFAULT_LOOKAHEAD_SECONDS - START_LEAD);

    rig.transport.seek(windowEnd);
    rig.runTo(4);

    expect(orphanOffCount(rig.calls)).toBe(0);
    rig.transport.dispose();
  });

  it("suppresses them after a main-thread stall re-anchors the timeline", () => {
    // The re-anchor cuts every held note but leaves the TICK stream
    // contiguous, so nothing in the window boundaries says "jump".
    rig = makeRig([clip(overlappingSamePitch, { length: 8 * BEAT })]);
    rig.transport.play(0);
    rig.runTo(0.1);

    rig.ctx.currentTime = 0.7; // 600 ms of main-thread stall
    rig.clock.tick();
    rig.runTo(4);

    expect(orphanOffCount(rig.calls)).toBe(0);
    rig.transport.dispose();
  });

  it("suppresses them across the loop brace", () => {
    rig = makeRig([clip(overlappingSamePitch, { length: 8 * BEAT })], {
      loop: { start: 0, end: 3 * BEAT, enabled: true },
    });
    rig.transport.play(0);
    rig.runTo(4);

    expect(orphanOffCount(rig.calls)).toBe(0);
    rig.transport.dispose();
  });
});

describe("transport — re-entrant seek from inside the scheduling loop", () => {
  it("keeps the seek instead of restoring the pre-seek cursor", () => {
    // A `WindowFiller` (SS11's automation sampler) runs INSIDE the scheduling
    // loop and is allowed to seek. The loop must not write its own pre-seek
    // `cursorTime`/`cursorTick` back afterwards: the anchor ring already
    // followed the seek, so the playhead and the audio would diverge for good.
    rig = makeRig([
      clip(
        Array.from({ length: 8 }, (_, i) => ({
          id: `n${String(i)}`,
          start: i * BEAT,
          dur: 100,
          pitch: 60 + i,
          vel: 100,
        })),
        { length: 8 * BEAT },
      ),
    ]);
    let sought = false;
    const unsub = rig.transport.addWindowFiller({
      fillWindow: () => {
        if (sought) return;
        sought = true;
        rig.transport.seek(6 * BEAT);
      },
    });

    rig.transport.play(0);
    rig.runTo(1.2);

    const pitches = rig.calls.filter((c) => c.kind === "on").map((c) => c.pitch);
    // 60 was scheduled before the seek; everything after it belongs to the
    // seek target (tick 6*BEAT = pitch 66) or later.
    for (const pitch of pitches.slice(1)) expect(pitch).toBeGreaterThanOrEqual(66);
    expect(rig.transport.positionTicks()).toBeGreaterThanOrEqual(6 * BEAT);

    unsub();
    rig.transport.dispose();
  });
});

describe("transport — re-entrancy from stop()'s panic", () => {
  it("tears down a playback pass restarted from inside the panic", () => {
    // `panic` calls `NoteTarget` methods, which are caller code. If one of
    // them restarts playback, `stop()` must not park `state` at "stopped"
    // while leaving that pass's clock ticking at 25 ms into an `onTick` that
    // returns immediately — nor leave its note-ons sounding behind the panic.
    const calls: Call[] = [];
    let restarted = false;
    const target: NoteTarget = {
      noteOn: (pitch, vel, when) => calls.push({ kind: "on", pitch, vel, when }),
      noteOff: (pitch, when) => calls.push({ kind: "off", pitch, vel: 0, when }),
      allNotesOff: (when) => {
        calls.push({ kind: "all", pitch: -1, vel: 0, when });
        if (restarted) return;
        restarted = true;
        rig.transport.play(2 * BEAT);
      },
    };
    rig = makeRig([clip([{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }])], {
      resolveTarget: () => target,
    });

    rig.transport.play(0);
    rig.transport.stop();

    expect(restarted).toBe(true);
    expect(rig.transport.state).toBe("stopped");
    expect(rig.clock.running).toBe(false);
    // Nothing the restarted pass scheduled is left sounding behind the panic.
    expect(calls.at(-1)?.kind).toBe("all");
    rig.transport.dispose();
  });
});
