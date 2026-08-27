import { expect, test, type Page, type Worker } from "@playwright/test";

// SS12 in a real browser: "runs in a dedicated Worker (main-thread timers
// throttle in background tabs)".
//
// Everything else in the suite is blind to which clock is running.
// `createDefaultClock` (src/engine/transport/clock.ts) falls back to
// `createTimerClock` — a main-thread `setInterval`, i.e. exactly the throttled
// timer SS12 rejects — whenever `new Worker(..., { type: "module" })` throws,
// and e2e/interaction/transport.spec.ts only proves that *some* clock keeps
// opening look-ahead windows. Both halves of the message protocol are unit
// tested against a stub worker (src/engine/transport/clock.test.ts), which
// leaves the real-Worker path as the untested one. These tests close it:
//
//   1. a dedicated Worker running the clock module actually exists in the page
//      after boot, and the live transport reports `clockKind === "worker"`
//      (so a silent degradation to the timer fallback fails the suite);
//   2. the look-ahead windows are driven by messages *posted from inside that
//      worker* — counted in the worker's own global scope — and not by any
//      main-thread timer;
//   3. the tick timer keeps firing on schedule while the main thread is
//      completely unavailable — the property SS12 bought by moving it off the
//      main thread.
//
// On (3) and background tabs: the literal scenario in SS12's parenthetical
// ("main-thread timers throttle in background tabs") cannot be staged in this
// harness. Headless Chromium reports `document.visibilityState === "visible"`
// for every page it ever opens — a second tab brought to the front does not
// background the first (verified in both the default headless shell and
// `channel: "chromium"`), and CDP has no visibility override
// (`Page.setWebLifecycleState` accepts only `active`/`frozen`, and freezing
// halts the main thread's task queue outright rather than throttling timers).
// So test (3) starves the main thread instead, which is the same distinction
// measured from the other side: a `setInterval` on a blocked main thread fires
// once, coalesced, when the thread comes back; a worker's timer keeps firing
// at 25 ms throughout. That is exactly the difference between
// `createTimerClock` and `createWorkerClock` under any main-thread stall,
// background throttling included.

/** Matches the built chunk (`assets/clock.worker-<hash>.js`) and the dev-server
 *  URL (`/src/workers/clock.worker.ts`) alike. */
const CLOCK_WORKER_URL = /clock\.worker/;

/** Boots audio, returning the clock worker the engine created while doing so.
 *  The worker is constructed by `createEngineTransport` during boot, so the
 *  waiter has to be armed before the click. */
async function bootAndGetClockWorker(page: Page): Promise<Worker> {
  await page.goto("/");
  const workerPromise = page.waitForEvent("worker", {
    predicate: (w) => CLOCK_WORKER_URL.test(w.url()),
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Boot audio" }).click();
  const worker = await workerPromise.catch(async (err: unknown) => {
    // Turn the bare `waitForEvent` timeout into the diagnosis: the usual cause
    // is `createDefaultClock` having fallen back to the main-thread timer.
    const kind = await page
      .evaluate(() => window.__fabletonDemo?.engine?.transport.clockKind ?? "no engine")
      .catch(() => "unreadable");
    throw new Error(
      `no dedicated Worker running the SS12 clock module appeared after boot ` +
        `(the live transport reports clockKind=${JSON.stringify(kind)}): ${String(err)}`,
    );
  });
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded/, {
    timeout: 10_000,
  });
  return worker;
}

test("the 25 ms clock runs in a dedicated Worker, not the main-thread fallback", async ({ page }) => {
  const worker = await bootAndGetClockWorker(page);

  // `page.workers()` only ever contains real dedicated workers, so this is
  // the direct evidence: the module the app loaded into one is the clock.
  expect(worker.url()).toMatch(CLOCK_WORKER_URL);
  expect(page.workers().map((w) => w.url())).toContain(worker.url());

  // ...and it is the clock the *transport* is using, not an orphan worker
  // that happens to be alive: `createDefaultClock` tags what it returned.
  const clockKind = await page.evaluate(() => {
    const transport = window.__fabletonDemo?.engine?.transport;
    if (!transport) throw new Error("live engine missing from the e2e bridge — check src/main.tsx");
    return transport.clockKind;
  });
  expect(
    clockKind,
    "the shipped app degraded to the throttled main-thread timer clock (SS12)",
  ).toBe("worker");
});

test("look-ahead windows are driven by ticks posted from inside the worker", async ({ page }) => {
  const worker = await bootAndGetClockWorker(page);

  // Count every message the worker posts, in the worker's own global scope.
  // src/workers/clock.worker.ts posts through `self`, so shadowing
  // `self.postMessage` with a counting wrapper observes the real tick path.
  await worker.evaluate(() => {
    const scope = self as unknown as {
      postMessage: (message: unknown) => void;
      __tickPosts?: number;
    };
    const original = scope.postMessage.bind(self);
    scope.__tickPosts = 0;
    scope.postMessage = (message: unknown): void => {
      scope.__tickPosts = (scope.__tickPosts ?? 0) + 1;
      original(message);
    };
  });

  // Count the look-ahead windows the transport opens, through the contract's
  // own `WindowFiller` seam (the one M3's automation sampler uses).
  await page.evaluate(() => {
    const transport = window.__fabletonDemo?.engine?.transport;
    if (!transport) throw new Error("live engine missing from the e2e bridge — check src/main.tsx");
    const state = window as unknown as { __windows: number };
    state.__windows = 0;
    transport.addWindowFiller({
      fillWindow() {
        state.__windows++;
      },
    });
    transport.play(0);
  });

  // ~25 ms per tick; a low bar so a loaded CI box cannot flake, but well past
  // the single window `play()` fills synchronously.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __windows: number }).__windows), {
      timeout: 5_000,
    })
    .toBeGreaterThan(4);

  // Stop first, then read both counters: after this, neither can advance, so
  // the comparison below is a snapshot of the same instant.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");

  const windows = await page.evaluate(
    () => (window as unknown as { __windows: number }).__windows,
  );
  const tickPosts = await worker.evaluate(
    () => (self as unknown as { __tickPosts?: number }).__tickPosts ?? 0,
  );

  // `play()` fills one window synchronously; every window after that one is a
  // tick this worker posted. If a main-thread timer were opening the windows,
  // `windows` would keep climbing while `tickPosts` stayed at 0.
  expect(tickPosts, "ticks posted by the clock worker").toBeGreaterThan(4);
  expect(
    windows,
    `look-ahead windows (${windows}) outran the worker's ticks (${tickPosts}) — something other than the worker clock is driving the scheduler`,
  ).toBeLessThanOrEqual(tickPosts + 1);
});

/** Long enough that a 25 ms timer should fire ~24 times, short enough not to
 *  slow the suite down. */
const BLOCK_MS = 600;
/** A main-thread `setInterval(25)` fires at most once or twice across a block
 *  this long (browsers coalesce the missed firings into one). Half the ticks
 *  a healthy worker clock produces in `BLOCK_MS` is far above that and far
 *  below the ~24 it actually manages, so a loaded CI box cannot flake. */
const MIN_TICKS_WHILE_BLOCKED = Math.floor(BLOCK_MS / 25 / 2);

test("the tick timer keeps firing while the main thread is blocked", async ({ page }) => {
  const worker = await bootAndGetClockWorker(page);

  await worker.evaluate(() => {
    const scope = self as unknown as {
      postMessage: (message: unknown) => void;
      __tickPosts?: number;
    };
    const original = scope.postMessage.bind(self);
    scope.__tickPosts = 0;
    scope.postMessage = (message: unknown): void => {
      scope.__tickPosts = (scope.__tickPosts ?? 0) + 1;
      original(message);
    };
  });

  // The clock only runs while the transport is playing.
  await page.evaluate(() => {
    const transport = window.__fabletonDemo?.engine?.transport;
    if (!transport) throw new Error("live engine missing from the e2e bridge — check src/main.tsx");
    transport.play(0);
  });

  const readTickPosts = (): Promise<number> =>
    worker.evaluate(() => (self as unknown as { __tickPosts?: number }).__tickPosts ?? 0);

  const before = await readTickPosts();
  // A hard busy-wait: no microtask, no timer and no message callback can run
  // on the page's main thread until this returns. `worker.evaluate` still
  // works — it is a separate CDP target on a separate thread, which is the
  // point being made.
  const startedAt = Date.now();
  await page.evaluate((ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      // spin
    }
  }, BLOCK_MS);
  const elapsed = Date.now() - startedAt;
  const after = await readTickPosts();

  expect(elapsed, "the block really ran").toBeGreaterThanOrEqual(BLOCK_MS);
  expect(
    after - before,
    `ticks posted while the main thread was blocked for ${elapsed} ms (a main-thread setInterval would have managed ~1)`,
  ).toBeGreaterThanOrEqual(MIN_TICKS_WHILE_BLOCKED);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");
});
