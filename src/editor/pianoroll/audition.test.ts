// SS10's "auditions at new pitch" for the KEYBOARD map. A key press has no
// release, so this module's timer is the only thing that ever stops a
// key-triggered voice — a regression here means permanently stuck notes. The
// injectable timer (SS15) makes all of it deterministic without a browser.

import { describe, expect, it } from "vitest";
import type { AuditionSink } from "../../types/editor";
import { KEY_AUDITION_HOLD_MS, createKeyboardAudition } from "./audition";

interface Recorder extends AuditionSink {
  readonly events: string[];
}

function recorder(): Recorder {
  const events: string[] = [];
  return {
    events,
    noteOn: (pitch, vel) => events.push(`on:${String(pitch)}:${String(vel)}`),
    noteOff: (pitch) => events.push(`off:${String(pitch)}`),
    allNotesOff: () => events.push("all-off"),
  };
}

/** A hand-cranked clock: `run()` fires the pending timer, exactly once. */
function timers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    cleared: [] as number[],
    setTimer(fn: () => void, ms: number): number {
      const handle = next++;
      pending.set(handle, { fn, ms });
      return handle;
    },
    clearTimer(handle: number): void {
      pending.delete(handle);
      this.cleared.push(handle);
    },
    run(): void {
      const [handle, entry] = [...pending.entries()][0] ?? [];
      if (handle === undefined || entry === undefined) return;
      pending.delete(handle);
      entry.fn();
    },
  };
}

describe("createKeyboardAudition", () => {
  it("plays the struck notes and schedules their release", () => {
    const sink = recorder();
    const clock = timers();
    const audition = createKeyboardAudition(() => sink, {
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => {
        clock.clearTimer(h);
      },
    });

    audition.strike([
      { pitch: 60, vel: 100 },
      { pitch: 64, vel: 90 },
    ]);
    expect(sink.events).toEqual(["on:60:100", "on:64:90"]);
    expect([...clock.pending.values()][0]?.ms).toBe(KEY_AUDITION_HOLD_MS);

    clock.run();
    expect(sink.events).toEqual(["on:60:100", "on:64:90", "off:60", "off:64"]);
    expect(clock.pending.size).toBe(0);
  });

  it("releases the previous voices — and cancels their timer — on a restrike", () => {
    const sink = recorder();
    const clock = timers();
    const audition = createKeyboardAudition(() => sink, {
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => {
        clock.clearTimer(h);
      },
    });

    audition.strike([{ pitch: 60, vel: 100 }]);
    audition.strike([{ pitch: 61, vel: 100 }]);
    expect(sink.events).toEqual(["on:60:100", "off:60", "on:61:100"]);
    // The first strike's timer was cleared, not left to fire later and cut
    // the second strike short.
    expect(clock.cleared).toHaveLength(1);
    expect(clock.pending.size).toBe(1);

    clock.run();
    expect(sink.events).toEqual(["on:60:100", "off:60", "on:61:100", "off:61"]);
  });

  it("caps simultaneous voices (a select-all transpose is not 2,000 note-ons)", () => {
    const sink = recorder();
    const clock = timers();
    const audition = createKeyboardAudition(() => sink, {
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => {
        clock.clearTimer(h);
      },
    });

    audition.strike(Array.from({ length: 2000 }, (_, i) => ({ pitch: 40 + (i % 60), vel: 100 })));
    expect(sink.events.filter((e) => e.startsWith("on:"))).toHaveLength(8); // the default cap

    clock.run();
    expect(sink.events.filter((e) => e.startsWith("off:"))).toHaveLength(8);
  });

  it("honours a custom maxVoices and holdMs", () => {
    const sink = recorder();
    const clock = timers();
    const audition = createKeyboardAudition(() => sink, {
      holdMs: 40,
      maxVoices: 2,
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => {
        clock.clearTimer(h);
      },
    });

    audition.strike([
      { pitch: 60, vel: 100 },
      { pitch: 62, vel: 100 },
      { pitch: 64, vel: 100 },
    ]);
    expect(sink.events).toEqual(["on:60:100", "on:62:100"]);
    expect([...clock.pending.values()][0]?.ms).toBe(40);
  });

  it("stopAll releases everything sounding and clears the timer", () => {
    const sink = recorder();
    const clock = timers();
    const audition = createKeyboardAudition(() => sink, {
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => {
        clock.clearTimer(h);
      },
    });

    audition.strike([{ pitch: 60, vel: 100 }]);
    audition.stopAll();
    expect(sink.events).toEqual(["on:60:100", "off:60"]);
    expect(clock.pending.size).toBe(0);

    // Idempotent: a second stop releases nothing twice.
    audition.stopAll();
    expect(sink.events).toEqual(["on:60:100", "off:60"]);
  });

  it("is a no-op with no sink, and never strands a voice when one appears", () => {
    let sink: AuditionSink | null = null;
    const clock = timers();
    const audition = createKeyboardAudition(() => sink, {
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => {
        clock.clearTimer(h);
      },
    });

    audition.strike([{ pitch: 60, vel: 100 }]);
    expect(clock.pending.size).toBe(0);

    const live = recorder();
    sink = live;
    audition.strike([{ pitch: 60, vel: 100 }]);
    clock.run();
    expect(live.events).toEqual(["on:60:100", "off:60"]);
  });

  it("uses real timers by default (the production wiring)", async () => {
    const sink = recorder();
    const audition = createKeyboardAudition(() => sink, { holdMs: 1 });
    audition.strike([{ pitch: 60, vel: 100 }]);
    expect(sink.events).toEqual(["on:60:100"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sink.events).toEqual(["on:60:100", "off:60"]);
  });
});
