// `core.limiter` — the promise, checked through the whole application.
//
// The kernel's own tests prove the bound in isolation, against signals chosen
// to break it. What only a browser can prove is that the promise survives the
// journey: through the worklet, through the SS6 graph, onto the master, and
// out into a rendered file. So this suite puts a limiter on the master with a
// low ceiling, drives the mix hard into it, exports the document, and reads
// every sample of the resulting WAV.

import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

function ctl(channelId: string, deviceId: string, localId: string): string {
  return `ctl-chan:${channelId}/dev:${deviceId}/${localId}`;
}

async function bootAndOpenMaster(page: Page): Promise<string> {
  // Deliberately NOT a `New` project: this suite needs the starter clip, so
  // that Play and Export have something to drive the limiter with.
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();
  const masterId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="master"]')
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-devices-${masterId}`).click();
  return masterId;
}

/** Types a value into a control, through its own three-verb gesture surface. */
async function typeInto(page: Page, testId: string, value: string): Promise<void> {
  await page.getByTestId(testId).focus();
  await page.keyboard.press("Enter");
  await page.getByTestId(`${testId}-entry`).fill(value);
  await page.getByTestId(`${testId}-entry`).press("Enter");
}

test("the Limiter offers five controls and a gain-reduction readout", async ({ page }) => {
  const masterId = await bootAndOpenMaster(page);
  await page.getByTestId("add-effect-select").selectOption({ label: "Limiter" });

  const card = page.locator(".fbl-device-chain > .fbl-device").last();
  const deviceId = ((await card.getAttribute("data-testid")) ?? "").replace("device-", "");
  for (const id of ["gain", "ceiling", "release", "autoRelease", "link"]) {
    await expect(page.getByTestId(ctl(masterId, deviceId, id))).toBeVisible();
  }
  // GR is a READOUT, not a param: it has a meter and no control.
  await expect(page.getByTestId(`readout-${deviceId}-reduction`)).toBeVisible();
  await expect(page.locator(`[data-testid$="/reduction"]`)).toHaveCount(0);

  // Stereo link is on by default — one gain for both channels, so a peak on
  // one side cannot pull the image toward the other.
  const link = page.getByTestId(ctl(masterId, deviceId, "link"));
  await expect(link).toHaveAttribute("aria-checked", "true");
  await expect(link).toHaveAttribute("aria-label", "Stereo Link");
});

/** Every sample of an exported WAV, reduced to its peak and its RMS. */
async function exportStats(page: Page): Promise<{ peak: number; rms: number }> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-wav-button").click();
  const path = await (await downloadPromise).path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path as string);
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (let i = 44; i + 1 < bytes.length; i += 2) {
    const sample = bytes.readInt16LE(i) / 0x8000;
    const abs = sample < 0 ? -sample : sample;
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
    count++;
  }
  return { peak, rms: Math.sqrt(sumSquares / Math.max(1, count)) };
}

test("nothing gets out above the ceiling — checked sample by sample in a rendered file", async ({
  page,
}) => {
  const masterId = await bootAndOpenMaster(page);

  // First, the reason the device exists: this project's mix is already over
  // full scale, and the export clips it flat at 1.0.
  const bare = await exportStats(page);
  expect(bare.peak).toBeGreaterThanOrEqual(1);

  await page.getByTestId("add-effect-select").selectOption({ label: "Limiter" });
  const card = page.locator(".fbl-device-chain > .fbl-device").last();
  const deviceId = ((await card.getAttribute("data-testid")) ?? "").replace("device-", "");

  // A low ceiling and enough gain that the mix is slammed into it: the file
  // has to sit AT the ceiling, which is what makes the bound worth checking.
  await typeInto(page, ctl(masterId, deviceId, "ceiling"), "-6");
  await typeInto(page, ctl(masterId, deviceId, "gain"), "18");
  const limited = await exportStats(page);

  const ceiling = 10 ** (-6 / 20); // 0.5012
  // One 16-bit step of slack (3e-5) and no more. The whole point is that this
  // is not "roughly" the ceiling.
  expect(limited.peak).toBeLessThanOrEqual(ceiling + 1 / 0x8000);
  // ...and it got there by limiting, not by turning down: 18 dB of gain puts
  // the mix hard against the ceiling and it sits right under it, from the
  // first sample of the file — no ramp-in, or the top of every render would
  // be an overshoot (which is why `ceiling` declares no de-zipper).
  expect(limited.peak).toBeGreaterThan(ceiling * 0.99);
  expect(limited.rms).toBeGreaterThan(0.02);
});

test("the GR meter moves while the limiter is working, and rests when it is not", async ({
  page,
}) => {
  const masterId = await bootAndOpenMaster(page);
  await page.getByTestId("add-effect-select").selectOption({ label: "Limiter" });
  const card = page.locator(".fbl-device-chain > .fbl-device").last();
  const deviceId = ((await card.getAttribute("data-testid")) ?? "").replace("device-", "");

  // The meter reads gain reduction as a NEGATIVE dB figure — it is showing
  // what the limiter took off, and taking something off is a minus.
  const readout = page.getByTestId(`readout-${deviceId}-reduction`);
  const reduction = async (): Promise<number> =>
    Math.abs(Number.parseFloat((await readout.locator(".fbl-readout-value").innerText()) || "0"));

  await expect(readout).toBeVisible();
  expect(await reduction()).toBe(0);

  // Ceiling on the floor, gain up: whatever the clip plays, it is over it.
  await typeInto(page, ctl(masterId, deviceId, "ceiling"), "-24");
  await typeInto(page, ctl(masterId, deviceId, "gain"), "18");
  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(reduction, { timeout: 8_000, message: "a slammed limiter must show reduction" })
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Stop" }).click();
});
