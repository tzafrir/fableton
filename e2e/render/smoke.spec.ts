import { expect, test } from "@playwright/test";

// Render-suite smoke test. Also the harness's proof for the SS6 seam: both
// the Vite dev server and `vite preview` send COOP/COEP so
// `crossOriginIsolated` is true and `SharedArrayBuffer` exists, which the
// M2 metering ring buffer will require.
test("app root mounts and the page is cross-origin isolated", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.getByRole("heading", { name: "Fableton" })).toBeVisible();

  const isolated = await page.evaluate(() => window.crossOriginIsolated);
  expect(isolated).toBe(true);

  const hasSharedArrayBuffer = await page.evaluate(() => typeof SharedArrayBuffer !== "undefined");
  expect(hasSharedArrayBuffer).toBe(true);
});
