import { expect, test } from "@playwright/test";
import { collectPageErrors } from "./helpers";

// M0 render probe check 1: the app loads at the preview URL with ZERO
// console errors, zero uncaught exceptions, zero failed asset requests —
// against a PRODUCTION build (see playwright.config.ts's webServer, which
// runs `vite build && vite preview`).
test("app loads against the production preview with no console/page/network errors", async ({ page }) => {
  const errors = collectPageErrors(page);

  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  // Assert on real, specific content — not just "the page rendered
  // something". A blank/unmounted #root should fail this test.
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.getByRole("heading", { name: "Fableton" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Boot audio" })).toBeVisible();
  await expect(page.getByTestId("audio-status")).toHaveText("idle");
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");

  // Let any async chunk loads / late console noise settle before asserting.
  await page.waitForTimeout(500);

  expect(errors.consoleErrors, "console errors").toEqual([]);
  expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
  expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
});
