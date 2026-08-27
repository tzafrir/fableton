// `core.reverb` — convolution reverb (SS18-M4) over a PROCEDURAL impulse:
// exponentially decaying noise, stereo-decorrelated, generated from a SEEDED
// PRNG so an offline export renders byte-identically run to run (SS12/SS2).
//
// `size` regenerates the impulse via a message binding — a rebuild, not a
// ramp, so it applies at the next render quantum; mid-playback size sweeps
// are not a thing convolution can do click-free and the descriptor says so
// in its label. `mix` is the usual equal-power pair.
//
// A rebuild is expensive (up to ~380k Math.pow calls and a ~2.8 MB buffer on
// the MAIN thread), and every message binding is pushed at gesture rate by a
// knob drag and at the SS11 200 Hz control rate by an automation lane — so
// the value is COALESCED before it reaches `makeImpulse`: quantised to
// perceptual steps, then rate-limited on the audio clock with a trailing
// rebuild so the value the user let go of is always the one that lands.
// Without that, dragging Size ran one multi-megabyte regeneration per
// pointermove and an automated Size ran ~200 per second inside the transport's
// window filler, starving the render thread (SS2 performance budgets).

import type { DeviceDefinition, DeviceInstance, Seconds } from "../../types";
import { p } from "../../params/descriptors";
import { deviceInstance, rampOutAndDisconnect } from "../harness/deviceInstance";

/** Deterministic xorshift32 — the seed keeps renders reproducible. */
export function makeNoise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** Stereo impulse: `seconds` long, 60 dB down by the end. */
export function makeImpulse(
  ctx: BaseAudioContext,
  seconds: number,
  seed = 0x5eed,
): AudioBuffer {
  const length = Math.max(64, Math.round(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rand = makeNoise(seed + ch * 7919);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // -60 dB exponential decay.
      data[i] = (rand() * 2 - 1) * Math.pow(10, -3 * t);
    }
  }
  return buffer;
}

/**
 * Relative step the requested size is rounded to. Reverb length is judged
 * proportionally (1.80 s vs 1.85 s is not a difference anyone can hear), so
 * the steps are geometric — and the whole 0.1..8 s range then holds ~90 of
 * them, which is the hard ceiling on how many rebuilds ANY sweep can cause.
 */
export const SIZE_STEP_RATIO = 1.05;

/** Minimum audio-clock spacing between two rebuilds. */
export const MIN_REBUILD_INTERVAL_S = 0.1;

/** Rounds a size in seconds to the nearest `SIZE_STEP_RATIO` step. */
export function quantiseSize(seconds: number): number {
  const clamped = Math.max(0.001, seconds);
  const step = Math.round(Math.log(clamped) / Math.log(SIZE_STEP_RATIO));
  return SIZE_STEP_RATIO ** step;
}

export interface SizeCoalescerOptions {
  /** The expensive thing: regenerate and install the impulse. */
  rebuild(seconds: number): void;
  /** Audio clock (`ctx.currentTime`) — never `Date.now` (SS12 two clocks). */
  now(): Seconds;
  /**
   * Wall-clock timer for the TRAILING rebuild. Omitted for an offline render,
   * where a wall-clock callback would land at an arbitrary point in the
   * render and break SS12's "same project renders identically"; offline the
   * automation stream keeps pushing, so a dropped value is re-pushed and the
   * gate lets the next one through on its own.
   */
  defer?: ((cb: () => void, ms: number) => void) | undefined;
  minIntervalS?: number | undefined;
}

/**
 * Wraps `rebuild` in the quantise + rate-limit + trailing-value policy above.
 * Pure of Web Audio, so the policy is unit-testable on its own (SS15).
 */
export function createSizeCoalescer(
  options: SizeCoalescerOptions,
): (seconds: number, when: Seconds) => void {
  const minIntervalS = options.minIntervalS ?? MIN_REBUILD_INTERVAL_S;
  let applied = Number.NaN;
  let appliedAt = Number.NEGATIVE_INFINITY;
  let pending: number | null = null;
  let timerArmed = false;

  const apply = (size: number, at: number): void => {
    applied = size;
    appliedAt = at;
    pending = null;
    options.rebuild(size);
  };

  const flush = (): void => {
    timerArmed = false;
    const wanted = pending;
    pending = null;
    if (wanted === null || wanted === applied) return;
    apply(wanted, options.now());
  };

  return (seconds: number, when: Seconds): void => {
    const size = quantiseSize(seconds);
    if (size === applied) {
      // The sweep came back to where the impulse already is: nothing to do,
      // and no trailing rebuild owed either.
      pending = null;
      return;
    }
    const at = Math.max(when, options.now());
    if (at - appliedAt >= minIntervalS) {
      apply(size, at);
      return;
    }
    pending = size;
    if (options.defer !== undefined && !timerArmed) {
      timerArmed = true;
      options.defer(flush, Math.max(1, Math.ceil((appliedAt + minIntervalS - at) * 1000)));
    }
  };
}

export const Reverb: DeviceDefinition = {
  id: "core.reverb",
  version: 1,
  kind: "audioEffect",
  label: "Reverb",
  audioIn: [{ id: "in" }],
  audioOut: [{ id: "out" }],
  params: [
    p.continuous("size", "Size (rebuilds)", { min: 0.1, max: 8, default: 1.8, unit: "s", taper: "log" }),
    p.pct("mix", "Mix", { default: 30 }),
  ],

  create(ctx, io): DeviceInstance {
    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    const wet = ctx.createGain();
    const dry = ctx.createGain();

    io.in.connect(dry);
    dry.connect(io.out);
    io.in.connect(convolver);
    convolver.connect(wet);
    wet.connect(io.out);

    // `OfflineAudioContext` is the SS12 export path: no wall-clock timers
    // there, so the trailing rebuild is live-context only.
    const offline = "startRendering" in ctx;
    let disposed = false;
    const pushSize = createSizeCoalescer({
      rebuild: (seconds) => {
        // A trailing rebuild may still be armed when the device goes away.
        if (disposed) return;
        convolver.buffer = makeImpulse(ctx, seconds);
      },
      now: () => ctx.currentTime,
      defer: offline
        ? undefined
        : (cb, ms) => {
            setTimeout(cb, ms);
          },
    });

    return deviceInstance({
      gainParams: { mix: [wet, dry] },
      connectParam: (localId, handle) => {
        if (localId !== "size") return;
        handle.bindMessage((seconds, when) => {
          pushSize(seconds, when);
        });
      },
      dispose: (when?: Seconds): void => {
        disposed = true;
        rampOutAndDisconnect(when, [dry, wet], { context: ctx, also: [convolver] });
      },
    });
  },
};
