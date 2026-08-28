// `core.fm` — the four-operator Operator, through the UI it is reached by.
//
// Its algorithm table and voice graph are unit-tested headlessly against the
// fake context. What needs a real browser is the panel: that the device
// brings its own editor instead of a thirty-eight-knob grid, that clicking an
// algorithm picture writes the document, that the operator tabs re-describe
// themselves when the routing changes — and, the one claim no headless test
// can make, that four real oscillators wired into each other's `frequency`
// params produce sound in a real AudioContext.

import { expect, test, type Page } from "@playwright/test";

/** Control testids carry the FULL param path, the app's own convention. */
function ctl(trackId: string, deviceId: string, localId: string): string {
  return `ctl-chan:${trackId}/dev:${deviceId}/${localId}`;
}

async function addOperator(page: Page): Promise<{ trackId: string; deviceId: string }> {
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
  await page.getByTestId("instrument-select").selectOption({ label: "Operator" });
  const card = page.locator('.fbl-device[data-editor="operator"]');
  await expect(card).toBeVisible();
  return {
    trackId,
    deviceId: ((await card.getAttribute("data-testid")) ?? "").replace("device-", ""),
  };
}

test("the Operator brings its own editor instead of a knob grid", async ({ page }) => {
  const { deviceId } = await addOperator(page);

  // Eleven algorithms, drawn.
  await expect(page.getByTestId(`operator-algorithm-${deviceId}-1`)).toBeVisible();
  await expect(page.getByTestId(`operator-algorithm-${deviceId}-11`)).toBeVisible();
  await expect(page.getByTestId("operator-algorithms").locator("svg")).toHaveCount(11);

  // Four operator tabs, and one envelope for whichever is selected.
  for (const name of ["A", "B", "C", "D"]) {
    await expect(page.getByTestId(`operator-tab-${deviceId}-${name}`)).toBeVisible();
  }
  await expect(page.getByTestId("operator-envelope")).toBeVisible();

  // The 38 params are NOT drawn as a grid of rows.
  await expect(page.getByTestId(`device-${deviceId}`).locator(".fbl-param-row")).toHaveCount(0);
});

test("picking an algorithm writes the document and re-describes the operators", async ({ page }) => {
  const { trackId, deviceId } = await addOperator(page);

  // Algorithm 1 is the serial stack: B, C and D each modulate the next.
  await expect(page.getByTestId(`operator-tab-${deviceId}-B`)).toContainText("→A");
  await expect(page.getByTestId(`operator-tab-${deviceId}-D`)).toContainText("→C");

  // Algorithm 11 is additive: every operator is a carrier.
  await page.getByTestId(`operator-algorithm-${deviceId}-11`).click();
  for (const name of ["A", "B", "C", "D"]) {
    await expect(page.getByTestId(`operator-tab-${deviceId}-${name}`)).toContainText("out");
  }

  const stored = await page.evaluate(() => {
    const doc = window.__fabletonDemo!.store!.getState();
    const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
    const dev = doc.channels[track]!.source!.deviceId;
    return doc.paramValues[`chan:${track}/dev:${dev}/algorithm`];
  });
  expect(stored).toBe(10); // eleventh, zero-based

  // One click, one undo entry — the picker IS the gesture.
  await page.getByTestId("undo-button").click();
  await expect(page.getByTestId(ctl(trackId, deviceId, "algorithm"))).toHaveCount(0); // no stray grid
  await expect(page.getByTestId(`operator-tab-${deviceId}-D`)).toContainText("→C");
});

test("each operator tab shows its OWN ratio and envelope", async ({ page }) => {
  const { trackId, deviceId } = await addOperator(page);

  // A is the carrier at ratio 1.
  await expect(page.getByTestId(ctl(trackId, deviceId, "aCoarse"))).toBeVisible();
  await expect(page.getByTestId("operator-ratio")).toContainText("1.00");

  // B is the modulator at ratio 2 — a different operator, different knobs.
  await page.getByTestId(`operator-tab-${deviceId}-B`).click();
  await expect(page.getByTestId(ctl(trackId, deviceId, "bCoarse"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "aCoarse"))).toHaveCount(0);
  await expect(page.getByTestId("operator-ratio")).toContainText("2.00");

  // Coarse and Fine are integers that read as one number: 2 + 0.50.
  await page.getByTestId(`${ctl(trackId, deviceId, "bFine")}-label`).click();
  await page.getByTestId(`${ctl(trackId, deviceId, "bFine")}-entry`).fill("50");
  await page.getByTestId(`${ctl(trackId, deviceId, "bFine")}-entry`).press("Enter");
  await expect(page.getByTestId("operator-ratio")).toContainText("2.50");
});

test("four operators wired into each other actually make sound", async ({ page }) => {
  const { trackId, deviceId } = await addOperator(page);

  // The deep stack, with every operator switched on: D modulates C modulates
  // B modulates A. Four oscillators, three of them landing on another's
  // frequency param — the arrangement most likely to produce silence if an
  // edge is wired the wrong way round.
  await page.getByTestId(`operator-algorithm-${deviceId}-1`).click();
  for (const name of ["C", "D"]) {
    await page.getByTestId(`operator-tab-${deviceId}-${name}`).click();
    await page.getByTestId(ctl(trackId, deviceId, `${name.toLowerCase()}On`)).click();
  }

  const masterId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="master"]')
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  const meter = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
  const level = async (): Promise<number> => {
    const h = await meter.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(h === "" ? "0" : h);
  };

  // Played from the computer keyboard: a fresh project's clip is EMPTY, so
  // pressing Play would prove something about the clip and nothing about the
  // instrument.
  expect(await level()).toBe(0);
  await page.keyboard.down("a");
  await expect
    .poll(level, { timeout: 5_000, message: "a four-operator stack must be audible" })
    .toBeGreaterThan(0);
  await page.keyboard.up("a");
});
