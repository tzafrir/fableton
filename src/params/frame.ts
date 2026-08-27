// rAF coalescing for `ParamHandle.onChange` (SS4: "coalesced to rAF").
//
// A knob drag or an automation window can write a param hundreds of times per
// second; the UI only ever needs the latest value once per frame. Everything
// is injectable so headless tests (SS15) drive frames deterministically.

/** Schedules `cb` for the next frame and returns a cancellation token. */
export type FrameScheduler = (cb: () => void) => unknown;
export type FrameCanceller = (token: unknown) => void;

export interface FrameSchedulerOptions {
  schedule?: FrameScheduler | undefined;
  cancel?: FrameCanceller | undefined;
}

export interface FrameBatcher {
  /** Ensures `run` executes at most once on the next frame. */
  request(): void;
  /** True while a frame is pending. */
  readonly pending: boolean;
  /** Runs `run` immediately if pending (tests, and flush-before-teardown). */
  flush(): void;
  /** Drops a pending frame without running it. */
  cancel(): void;
}

function defaultSchedule(cb: () => void): unknown {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(() => cb());
  }
  // Headless (node/worker) fallback: roughly one frame.
  return setTimeout(cb, 16);
}

function defaultCancel(token: unknown): void {
  if (typeof token === "number" && typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(token);
    return;
  }
  clearTimeout(token as ReturnType<typeof setTimeout>);
}

export function createFrameBatcher(
  run: () => void,
  options: FrameSchedulerOptions = {},
): FrameBatcher {
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? (options.schedule === undefined ? defaultCancel : undefined);
  let token: unknown = null;
  let pending = false;

  const fire = (): void => {
    token = null;
    if (!pending) return;
    pending = false;
    run();
  };

  return {
    get pending() {
      return pending;
    },
    request(): void {
      if (pending) return;
      pending = true;
      token = schedule(fire);
    },
    flush(): void {
      if (!pending) return;
      pending = false;
      if (token !== null && cancel !== undefined) cancel(token);
      token = null;
      run();
    },
    cancel(): void {
      if (!pending) return;
      pending = false;
      if (token !== null && cancel !== undefined) cancel(token);
      token = null;
    },
  };
}
