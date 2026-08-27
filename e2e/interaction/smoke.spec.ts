import { expect, test } from "@playwright/test";

// Interaction-suite smoke test. Mostly trivial — M0 has no real interactive
// surface yet — but the click also boots the AudioContext, which proves the
// worklet build/bundling seam (SS15) end to end against a real browser and
// a production build, not just `tsc`/`vite build` succeeding.
test("page is interactive, reports its device pixel ratio, and boots audio on click", async ({
  page,
}) => {
  await page.goto("/");

  const dpr = await page.evaluate(() => window.devicePixelRatio);
  expect(dpr).toBe(2);

  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded/, {
    timeout: 10_000,
  });
});
