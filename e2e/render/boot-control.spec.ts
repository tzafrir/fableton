import { expect, test } from "@playwright/test";
import { collectPageErrors } from "./helpers";

// M0 render probe check 2: the boot/unlock control is present and labeled;
// screenshot the initial state. See src/app/App.tsx — "Boot audio" is the
// SS18-M0 "Context boot + unlock" gesture-triggered entry point.
test("boot/unlock control is present, labeled, and enabled before boot", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fableton" })).toBeVisible();

  const bootButton = page.getByRole("button", { name: "Boot audio" });
  await expect(bootButton).toBeVisible();
  await expect(bootButton).toBeEnabled();

  // Play/Stop are gated on the engine existing — should start disabled.
  await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();

  await expect(page.getByTestId("audio-status")).toHaveText("idle");

  await page.screenshot({
    path: ".playwright/screenshots/M0/render/boot-control-initial.png",
    fullPage: true,
  });

  expect(errors.consoleErrors, "console errors").toEqual([]);
  expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
  expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
});

// Exercises the real unlock gesture the app requires (a click), then
// screenshots the post-boot state so a human can eyeball that "ready" text
// and the transport buttons actually reflect a live engine, not a stuck
// spinner state.
test("clicking Boot audio unlocks the engine and enables transport controls", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/");
  const bootButton = page.getByRole("button", { name: "Boot audio" });
  await bootButton.click();

  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded, state=running\)$/, {
    timeout: 10_000,
  });
  await expect(bootButton).toBeDisabled();
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();

  // Boot makes the transport controls LIVE — which since M1 means each one
  // tracks the SS12 transport state rather than being unconditionally
  // clickable: Stop is inert while already stopped, and becomes available
  // the moment Play moves the transport. Asserting the transition (rather
  // than "both buttons enabled", as M0 did when Stop was always on) is what
  // actually proves the engine behind them is live.
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("playing");
  await expect(page.getByRole("button", { name: "Stop" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");

  await page.screenshot({
    path: ".playwright/screenshots/M0/render/boot-control-ready.png",
    fullPage: true,
  });

  expect(errors.consoleErrors, "console errors").toEqual([]);
  expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
  expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
});
