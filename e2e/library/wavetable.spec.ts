// `core.wavetable` — the two-oscillator wavetable synth, through the UI it is
// reached by.
//
// Its tables, filters, LFOs and matrix are unit-tested headlessly, and the
// worklet's composition is driven head-on in Vitest. What needs a real
// browser is the panel: that ninety params arrive as five views and a picture
// rather than as a wall of knobs, that the views are actually about different
// halves of the instrument, that a matrix cell is a real param you can type
// into — and the one claim no headless test can make, that the whole voice
// path produces sound in a real AudioContext.

import { expect, test, type Page } from "@playwright/test";

/** Control testids carry the FULL param path, the app's own convention. */
function ctl(trackId: string, deviceId: string, localId: string): string {
  return `ctl-chan:${trackId}/dev:${deviceId}/${localId}`;
}

async function addWavetable(page: Page): Promise<{ trackId: string; deviceId: string }> {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  // Params are registered by the ENGINE, which does not exist until audio is
  // booted — an unbooted panel draws placeholders, not controls (SS5).
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();
  const trackId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="track"]')
      .first()
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-devices-${trackId}`).click();
  await page.getByTestId("instrument-select").selectOption({ label: "Wavetable" });
  const card = page.locator('.fbl-device[data-editor="wavetable"]');
  await expect(card).toBeVisible();
  return {
    trackId,
    deviceId: ((await card.getAttribute("data-testid")) ?? "").replace("device-", ""),
  };
}

/**
 * A param's value as the DOCUMENT has it — the only proof a gesture landed.
 *
 * An untouched param has no entry at all: the document stores what was
 * CHANGED, and a param's value until then is its default (SS13). Every matrix
 * cell's default is zero, so "absent" and "zero" are the same reading here.
 */
async function stored(page: Page, localId: string): Promise<number> {
  return page.evaluate((id) => {
    const doc = window.__fabletonDemo!.store!.getState();
    const track = doc.channelOrder.find((c) => doc.channels[c]?.role === "track")!;
    const dev = doc.channels[track]!.source!.deviceId;
    return doc.paramValues[`chan:${track}/dev:${dev}/${id}`] ?? 0;
  }, localId);
}

test("the Wavetable brings a picture and five views, not ninety knobs", async ({ page }) => {
  const { deviceId } = await addWavetable(page);

  await expect(page.getByTestId("wavetable-display")).toBeVisible();
  await expect(page.getByTestId("wavetable-caption")).toContainText("Osc A · Basics");
  for (const view of ["osc", "filter", "env", "lfo", "matrix"]) {
    await expect(page.getByTestId(`wavetable-view-${deviceId}-${view}`)).toBeVisible();
  }
  // The ninety params are NOT drawn as a grid of rows.
  await expect(page.getByTestId(`device-${deviceId}`).locator(".fbl-param-row")).toHaveCount(0);
});

test("the two oscillators are two oscillators — the display follows the one you pick", async ({
  page,
}) => {
  const { trackId, deviceId } = await addWavetable(page);

  await expect(page.getByTestId(ctl(trackId, deviceId, "aPos"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "bPos"))).toBeVisible();

  // The picture is of Osc A's table until Osc B is picked, and B ships on a
  // different one — so the caption is the proof the display followed.
  await page.getByTestId(`wavetable-osc-${deviceId}-1`).click();
  await expect(page.getByTestId("wavetable-caption")).toContainText("Osc B · Pulse");
  await expect(page.getByTestId("wavetable-caption")).toContainText("duty cycle");
});

test("the filter view draws the response, and the routing changes what it is a response OF", async ({
  page,
}) => {
  const { trackId, deviceId } = await addWavetable(page);
  await page.getByTestId(`wavetable-view-${deviceId}-filter`).click();
  await expect(page.getByTestId("wavetable-filter-curve")).toBeVisible();
  await expect(page.getByTestId("wavetable-routing-hint")).toContainText("Filter 1, then Filter 2");

  // One filter on: no combined curve to draw, because there is no pair.
  await expect(page.getByTestId("wavetable-filter-combined")).toHaveCount(0);
  await page.getByTestId(ctl(trackId, deviceId, "f2On")).click();
  await expect(page.getByTestId("wavetable-filter-combined")).toBeVisible();

  // In parallel the two are not in series, so their product is not the
  // answer and the panel stops claiming it is.
  const routing = page.getByTestId(ctl(trackId, deviceId, "routing"));
  await routing.getByRole("radio", { name: "Parallel" }).click();
  await expect(page.getByTestId("wavetable-routing-hint")).toContainText("summed");
  await expect(page.getByTestId("wavetable-filter-combined")).toHaveCount(0);

  await routing.getByRole("radio", { name: "Split" }).click();
  await expect(page.getByTestId("wavetable-routing-hint")).toContainText("Osc A → Filter 1");
});

test("three envelopes are three sets of knobs, not one set with three names", async ({ page }) => {
  const { trackId, deviceId } = await addWavetable(page);
  await page.getByTestId(`wavetable-view-${deviceId}-env`).click();

  await expect(page.getByTestId(ctl(trackId, deviceId, "ampAttack"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "env2Attack"))).toHaveCount(0);
  await expect(page.getByTestId("wavetable-envelope")).toBeVisible();

  await page.getByTestId(`wavetable-env-${deviceId}-1`).click();
  await expect(page.getByTestId(ctl(trackId, deviceId, "env2Attack"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "ampAttack"))).toHaveCount(0);
});

test("the matrix is a grid, and every cell is a real param", async ({ page }) => {
  const { trackId, deviceId } = await addWavetable(page);
  await page.getByTestId(`wavetable-view-${deviceId}-matrix`).click();

  const grid = page.getByTestId("wavetable-matrix");
  await expect(grid).toBeVisible();
  await expect(grid.locator('[role="slider"]')).toHaveCount(42);

  // Every cell starts at zero, so nothing is highlighted and nothing is
  // modulating: the instrument is only what you can see.
  await expect(grid.locator('.fbl-wt-cell[data-active="true"]')).toHaveCount(0);
  expect(await stored(page, "modLfo1Cut1")).toBe(0);

  // Type into one — same three verbs every knob in the app has.
  const cell = page.getByTestId(ctl(trackId, deviceId, "modLfo1Cut1"));
  await cell.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId(`${ctl(trackId, deviceId, "modLfo1Cut1")}-entry`).fill("45");
  await page.getByTestId(`${ctl(trackId, deviceId, "modLfo1Cut1")}-entry`).press("Enter");

  expect(await stored(page, "modLfo1Cut1")).toBeCloseTo(45, 3);
  await expect(grid.locator('.fbl-wt-cell[data-active="true"]')).toHaveCount(1);

  // One gesture, one undo entry.
  await page.getByTestId("undo-button").click();
  expect(await stored(page, "modLfo1Cut1")).toBe(0);
});

test("two oscillators through two filters actually make sound", async ({ page }) => {
  const { trackId, deviceId } = await addWavetable(page);

  // The full path: both oscillators on, both filters in series, and a
  // modulation cell live — the arrangement most likely to produce silence if
  // any one of them is wired the wrong way round.
  await page.getByTestId(ctl(trackId, deviceId, "bOn")).click();
  await page.getByTestId(`wavetable-view-${deviceId}-filter`).click();
  await page.getByTestId(ctl(trackId, deviceId, "f2On")).click();
  await page.getByTestId(`wavetable-view-${deviceId}-matrix`).click();
  const cell = page.getByTestId(ctl(trackId, deviceId, "modEnv2Cut1"));
  await cell.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId(`${ctl(trackId, deviceId, "modEnv2Cut1")}-entry`).fill("60");
  await page.getByTestId(`${ctl(trackId, deviceId, "modEnv2Cut1")}-entry`).press("Enter");

  const masterId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="master"]')
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId("tab-mixer").click();
  const meter = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
  const level = async (): Promise<number> => {
    const h = await meter.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(h === "" ? "0" : h);
  };

  // Played from the computer keyboard: a fresh project's clip is EMPTY, so
  // Play would prove something about the clip and nothing about the synth.
  expect(await level()).toBe(0);
  await page.keyboard.down("a");
  await expect
    .poll(level, { timeout: 5_000, message: "a two-oscillator wavetable voice must be audible" })
    .toBeGreaterThan(0);
  await page.keyboard.up("a");
});
