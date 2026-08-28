import { expect, test } from "@playwright/test";

// The visualisers (spectrum + level history), against a production build.
//
// What a browser can prove that a unit test cannot: that the rAF paint loop
// actually runs, that the canvases get a real device-pixel backing store at
// the panel's size, and — the point of the `active` flag — that a hidden tab
// stops painting instead of running an FFT per frame forever.
//
// The MATH (log axis, band folding, level scaling) is covered headlessly in
// src/app/panels/scope/analysis.test.ts; nothing here re-asserts it.

test("the scope paints once audio is up, and stops when its tab is hidden", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await page.getByTestId("tab-scope").click();

  const spectrum = page.getByTestId("scope-spectrum");
  const level = page.getByTestId("scope-level");
  await expect(spectrum).toBeVisible();
  await expect(level).toBeVisible();

  // A canvas only gets a backing store from inside the paint loop, so a
  // non-zero `width` IS the proof that the loop ran.
  const sized = async (): Promise<{ w: number; h: number }> =>
    spectrum.evaluate((el) => ({
      w: (el as HTMLCanvasElement).width,
      h: (el as HTMLCanvasElement).height,
    }));
  await expect.poll(async () => (await sized()).w).toBeGreaterThan(0);
  const painted = await sized();
  expect(painted.h).toBeGreaterThan(0);
  await expect
    .poll(async () => level.evaluate((el) => (el as HTMLCanvasElement).width))
    .toBeGreaterThan(0);

  // Hidden: the panel stays MOUNTED (its ten seconds of history is state
  // worth keeping across a tab flip) but must stop painting.
  await page.getByTestId("tab-mixer").click();
  await expect(page.getByTestId("scope-panel")).toBeHidden();
  const before = await spectrum.evaluate(
    (el) => (el as HTMLCanvasElement).toDataURL().length,
  );
  await page.waitForTimeout(250);
  const after = await spectrum.evaluate((el) => (el as HTMLCanvasElement).toDataURL().length);
  expect(after).toBe(before);

  // ...and resumes when it comes back.
  await page.getByTestId("tab-scope").click();
  await expect(spectrum).toBeVisible();
  await expect.poll(async () => (await sized()).w).toBeGreaterThan(0);
});

test("the scope names the channel it is looking at, and follows the selection", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await page.getByTestId("tab-scope").click();
  // The shell opens with the first track selected, and the scope looks at
  // whatever the rest of the app is pointed at — the same channel whose
  // device chain is on screen — rather than at a fixed bus.
  await expect(page.getByTestId("scope-source")).toHaveText("Track 1");

  await page.getByTestId("tab-mixer").click();
  await page.getByText("Master", { exact: true }).first().click();
  await page.getByTestId("tab-scope").click();
  await expect(page.getByTestId("scope-source")).toHaveText("Master");
});
