import { expect, test } from "@playwright/test";

// Interaction-suite: Play/Stop only enable once the demo chain is mounted,
// and clicking them actually drives the SS12 transport state machine
// end to end in a real browser (the click also proves the demo chain wires
// up — mount is async — without needing to inspect audio samples here; see
// e2e/audio/offline-render.spec.ts for the non-silence proof).
test("play/stop enable after boot and toggle the transport state", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded/, {
    timeout: 10_000,
  });

  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("playing");

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");
});

// SS12's two-clock design in a real browser: the transport's clock keeps
// ticking past the first look-ahead window (that window is scheduled
// synchronously by `play()`, so a dead clock would still make 200 ms of sound
// and pass every other test in this file).
// A `WindowFiller` — the contract's own seam, the one M3's automation
// sampler uses — counts the windows the transport opens while playing.
// That the ticking clock is the dedicated Worker rather than the throttled
// main-thread fallback is a distinction this test cannot make; it is proved
// in e2e/interaction/clock-worker.spec.ts.
test("the clock keeps opening look-ahead windows while playing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded/, {
    timeout: 10_000,
  });

  await page.evaluate(() => {
    const transport = window.__fabletonDemo?.engine?.transport;
    if (!transport) throw new Error("live engine missing from the e2e bridge — check src/main.tsx");
    const horizons: number[] = [];
    (window as unknown as { __horizons: number[] }).__horizons = horizons;
    transport.addWindowFiller({
      fillWindow(horizonSeconds) {
        horizons.push(horizonSeconds);
      },
    });
    transport.play(0);
  });

  // ~25 ms per tick: half a second is ~20 windows. Assert far below that so
  // a loaded CI box cannot flake, but well above the single window `play()`
  // schedules synchronously.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __horizons: number[] }).__horizons.length), {
      timeout: 5_000,
    })
    .toBeGreaterThan(4);

  // Each window's horizon is ahead of the last — the look-ahead is walking
  // forward with `ctx.currentTime`, not re-scheduling the same window.
  const horizons = await page.evaluate(
    () => (window as unknown as { __horizons: number[] }).__horizons,
  );
  expect(horizons.at(-1)!).toBeGreaterThan(horizons[0]!);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");
});
