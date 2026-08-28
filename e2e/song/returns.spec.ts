// Phase R + Phase 0 (SS6): the two return-channel gaps, and the narrowed
// same-channel sidechain rule that gated reverb depends on.
//
// Returns themselves shipped in M2 — model, graph, params, cycle check and
// solo-in-place all had tests. What had no control surface was `SendSpec.tap`
// (so every send was permanently post-fader) and what had a control it should
// not was a return's send to itself (inert: `setSend`'s canRun rejects it).

import { expect, test, type Page } from "@playwright/test";

async function mixerWithReturn(
  page: Page,
  options: { withContent?: boolean } = {},
): Promise<{ trackId: string; returnId: string }> {
  await page.goto("/");
  // `New` gives a clean document whose single clip is EMPTY — fine for
  // structural assertions, useless for anything that has to hear something.
  // The starter project ships a real phrase, so audio probes keep it.
  if (options.withContent !== true) {
    await page.getByRole("button", { name: "New", exact: true }).click();
  }
  await page.getByTestId("tab-mixer").click();
  await page.getByTestId("add-return-button").click();

  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  const returnId = (
    (await page.locator('[data-testid^="strip-"][data-role="return"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  return { trackId, returnId };
}

test("a return offers sends to other returns, never to itself", async ({ page }) => {
  const { returnId } = await mixerWithReturn(page);
  // One return exists: its own strip must show no send control at all.
  await expect(page.locator(`[data-testid^="add-send-${returnId}-"]`)).toHaveCount(0);
  await expect(page.locator(`[data-testid="sends-${returnId}"]`)).toHaveCount(0);

  // Add a second return: now each return may feed the other, one control each.
  await page.getByTestId("add-return-button").click();
  const returns = await page
    .locator('[data-testid^="strip-"][data-role="return"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") ?? "").replace("strip-", "")));
  for (const id of returns) {
    await expect(page.locator(`[data-testid^="add-send-${id}-"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="add-send-${id}-${id}"]`)).toHaveCount(0);
  }
});

test("send tap: the control exists, defaults to post, toggles, and undoes", async ({ page }) => {
  const { trackId, returnId } = await mixerWithReturn(page);
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });

  await page.getByTestId(`add-send-${trackId}-${returnId}`).click();
  const tap = page.getByTestId(`send-tap-${trackId}-${returnId}`);
  await expect(tap).toHaveText("POST");

  await tap.click();
  await expect(tap).toHaveText("PRE");
  await page.getByTestId("undo-button").click();
  await expect(tap).toHaveText("POST");
});

test("a PRE-fader send keeps feeding the return with the channel fader at -inf", async ({ page }) => {
  const { trackId, returnId } = await mixerWithReturn(page, { withContent: true });
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });

  await page.getByTestId(`add-send-${trackId}-${returnId}`).click();
  // Open the send fully (its default is silence) via the knob's text entry —
  // reached by clicking the VALUE LINE under it (double-click is reset).
  await page.getByTestId(`send-${trackId}-${returnId}-label`).click();
  await page.getByTestId(`send-${trackId}-${returnId}-entry`).fill("0 dB");
  await page.getByTestId(`send-${trackId}-${returnId}-entry`).press("Enter");

  // Pull the channel fader to silence.
  await page.getByTestId(`vol-${trackId}-label`).click();
  await page.getByTestId(`vol-${trackId}-entry`).fill("-60 dB");
  await page.getByTestId(`vol-${trackId}-entry`).press("Enter");

  const returnMeter = page.locator(`[data-testid="meter-${returnId}"] > div`).first();
  const returnLevel = async (): Promise<number> => {
    const h = await returnMeter.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(h === "" ? "0" : h);
  };

  await page.getByRole("button", { name: "Play" }).click();

  // POST-fader (the default): the send follows the dead fader, so the return
  // stays silent.
  await page.waitForTimeout(1200);
  expect(await returnLevel(), "a post-fader send must die with the fader").toBeLessThan(1);

  // PRE-fader: the send taps ahead of the fader, so the return lights up
  // even though the channel itself is silent. This is the behaviour that was
  // unreachable before the tap control existed.
  await page.getByTestId(`send-tap-${trackId}-${returnId}`).click();
  await expect
    .poll(returnLevel, {
      timeout: 5_000,
      message: "a pre-fader send must survive the fader being pulled down",
    })
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Stop" }).click();
});

test("Phase 0: a device may key its own channel from preFx, but not from a downstream tap", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByTestId("tab-mixer").click();
  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");

  await page.getByTestId(`strip-devices-${trackId}`).click();
  await page.getByTestId("add-effect-select").selectOption({ label: "Compressor" });

  const scSource = page.locator('[data-testid^="sc-source-"]');
  await expect(scSource).toBeVisible();

  // The device's OWN channel is now an offered source (it was excluded, and
  // rejected by canRun, before Phase 0).
  await expect(scSource.locator(`option[value="${trackId}"]`)).toHaveCount(1);
  await scSource.selectOption(trackId);

  // It lands on preFx — the only same-channel tap that is feed-forward.
  const tap = page.locator('[data-testid^="sc-tap-"]');
  await expect(tap).toBeVisible();
  await expect(tap).toHaveValue("preFx");

  // The downstream taps are not offerable for a same-channel key — they
  // would close a loop, and the routing rules reject them, so the UI does
  // not present them as choices in the first place.
  await expect(tap.locator('option[value="postFx"]')).toBeDisabled();
  await expect(tap.locator('option[value="postFader"]')).toBeDisabled();

  // A cross-channel key gets the full set. It has to be a SIBLING track:
  // keying from the master would be a real cycle (this track feeds it), and
  // the SS6 check rightly rejects that — which is the rule Phase 0 narrowed,
  // not removed. The mixer is where tracks are added, and it is a separate
  // tab from the device chain now.
  await page.getByTestId("tab-mixer").click();
  await page.getByTestId("add-track-button").click();
  const sibling = (
    (await page
      .locator('[data-testid^="strip-"][data-role="track"]')
      .last()
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  expect(sibling).not.toBe(trackId);

  await page.getByTestId(`strip-devices-${trackId}`).click();
  await page.locator('[data-testid^="sc-source-"]').selectOption(sibling);
  await expect(page.locator('[data-testid^="sc-tap-"]').locator('option[value="postFader"]')).toBeEnabled();
});
