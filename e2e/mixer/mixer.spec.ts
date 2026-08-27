// M2 e2e (SS6/SS18-M2): the mixer against the real app — strips, sends,
// groups, solo/mute, device chains, fader gestures, and audio actually
// flowing through the reconciled graph (meter movement under playback).

import { expect, test, type Page } from "@playwright/test";

async function openMixer(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("tab-mixer").click();
  await expect(page.getByTestId("mixer-panel")).toBeVisible();
}

async function bootAudio(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
}

/** The starter project's track strip (first non-master strip). */
async function firstTrackId(page: Page): Promise<string> {
  const strip = page.locator('[data-testid^="strip-"][data-role="track"]').first();
  const testId = await strip.getAttribute("data-testid");
  if (testId === null) throw new Error("no track strip found");
  return testId.replace("strip-", "");
}

test("the mixer shows one strip per channel with the master last", async ({ page }) => {
  await openMixer(page);
  const strips = page.locator('[data-testid^="strip-"][data-role]');
  await expect(strips).toHaveCount(2); // starter project: one track + master
  await expect(strips.last()).toHaveAttribute("data-role", "master");
});

test("returns: add one, create a send to it, undo removes it again", async ({ page }) => {
  await openMixer(page);
  const trackId = await firstTrackId(page);

  await page.getByTestId("add-return-button").click();
  const returnStrip = page.locator('[data-testid^="strip-"][data-role="return"]');
  await expect(returnStrip).toHaveCount(1);

  // The track strip now offers an add-send stub for the new return.
  const addSend = page.locator(`[data-testid^="add-send-${trackId}-"]`);
  await expect(addSend).toHaveCount(1);
  await addSend.click();
  // Without audio the send knob's handle does not exist yet, but the send is
  // in the DOCUMENT: the stub is gone (replaced by knob or by nothing).
  await expect(page.locator(`[data-testid^="add-send-${trackId}-"]`)).toHaveCount(0);

  await page.getByTestId("undo-button").click(); // undo Set Send
  await expect(page.locator(`[data-testid^="add-send-${trackId}-"]`)).toHaveCount(1);
  await page.getByTestId("undo-button").click(); // undo Add Return
  await expect(returnStrip).toHaveCount(0);
});

test("grouping: select the track, group it, its Audio To points at the group", async ({ page }) => {
  await openMixer(page);
  const trackId = await firstTrackId(page);

  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("group-selected-button").click();

  const groupStrip = page.locator('[data-testid^="strip-"][data-role="group"]');
  await expect(groupStrip).toHaveCount(1);
  const groupTestId = await groupStrip.getAttribute("data-testid");
  const groupId = groupTestId?.replace("strip-", "") ?? "";

  const output = page.getByTestId(`output-${trackId}`);
  await expect(output).toHaveValue(groupId);

  // Rerouting back to the master is a one-field edit through the same select.
  await output.selectOption({ index: 1 }); // [group, master] -> master
  await expect(output).not.toHaveValue(groupId);
});

test("mute and solo are document toggles with pressed states", async ({ page }) => {
  await openMixer(page);
  const trackId = await firstTrackId(page);
  const mute = page.getByTestId(`mute-${trackId}`);
  const solo = page.getByTestId(`solo-${trackId}`);

  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await solo.click();
  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("undo-button").click();
  await expect(solo).toHaveAttribute("aria-pressed", "false");
  await expect(mute).toHaveAttribute("aria-pressed", "true");
});

test("device chain: add the Filter, tweak nothing, disable it, remove it", async ({ page }) => {
  await openMixer(page);
  await bootAudio(page);
  const trackId = await firstTrackId(page);
  await page.getByTestId(`strip-${trackId}`).click();

  await page.getByTestId("add-effect-select").selectOption({ label: "Filter" });
  const device = page.locator('[data-testid^="device-device"], [data-testid^="device-"][data-testid*="dev"]').last();
  const devicePanel = page.locator(".fbl-device").last();
  await expect(devicePanel).toBeVisible();

  // The auto-generated SS5 panel exposes the filter's cutoff as a knob once
  // the registry handle exists (audio is booted, reconciler mounted it).
  await expect(page.locator('[data-testid*="/cutoff"]').first()).toBeVisible();

  // Enable toggle bypasses (document flag flips; reconciler rewires live).
  const enable = devicePanel.locator('[data-testid^="device-enable-"]');
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "false");

  // Remove it; the panel goes away.
  await devicePanel.locator('[data-testid^="device-remove-"]').click();
  await expect(page.locator(".fbl-device")).toHaveCount(1); // instrument panel remains
  void device;
});

test("fader drag: one gesture, one undo entry, value moves through the dB taper", async ({ page }) => {
  await openMixer(page);
  await bootAudio(page);
  const trackId = await firstTrackId(page);
  const fader = page.getByTestId(`vol-${trackId}`);
  await expect(fader).toBeVisible();

  const before = await fader.getAttribute("aria-valuetext");
  const box = (await fader.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const undoCountBefore = await page.getByTestId("undo-button").isEnabled();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 30, { steps: 8 }); // down = quieter
  await page.mouse.up();

  const after = await fader.getAttribute("aria-valuetext");
  expect(after).not.toBe(before);

  // Exactly one undo entry for the whole drag (SS5 gesture end).
  await expect(page.getByTestId("undo-button")).toBeEnabled();
  await page.getByTestId("undo-button").click();
  await expect(fader).toHaveAttribute("aria-valuetext", before ?? "");
  if (!undoCountBefore) {
    await expect(page.getByTestId("undo-button")).toBeDisabled();
  }
});

test("audio flows through the reconciled graph: the master meter lights under playback", async ({
  page,
}) => {
  await openMixer(page);
  await bootAudio(page);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("playing");

  // The meter bar's rms fill is driven at rAF from the SS6 meter bus
  // (worklet/SAB in this crossOriginIsolated build). Any nonzero height
  // means real samples crossed the master's post-fader tap.
  const masterStrip = page.locator('[data-testid^="strip-"][data-role="master"]');
  const masterId = ((await masterStrip.getAttribute("data-testid")) ?? "").replace("strip-", "");
  const meterFill = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
  await expect
    .poll(
      async () => {
        const h = await meterFill.evaluate((el) => (el as HTMLElement).style.height);
        return Number.parseFloat(h === "" ? "0" : h);
      },
      { timeout: 5_000, message: "master meter should show signal while playing" },
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Stop" }).click();
});
