// The patch the racks plan was aimed at, end to end: a factory rack that
// builds a dry chain beside a Reverb -> Gate chain, with the gate keyed from
// the channel's own pre-FX tap.

import { expect, test } from "@playwright/test";

test("the Gated Reverb preset builds the whole patch, keyed pre-FX", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.__fabletonDemo?.store !== undefined), { timeout: 10_000 })
    .toBe(true);
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();

  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-factory-rack").selectOption("Gated Reverb");

  // Two chains: the dry signal, and the one the gate cuts.
  await expect(page.locator(".fbl-rack-chain")).toHaveCount(2);
  await expect(page.locator(".fbl-rack-chain .fbl-device")).toHaveCount(2); // reverb + gate

  const patch = await page.evaluate(() => {
    const doc = window.__fabletonDemo?.store?.getState();
    const rack = Object.values(doc?.racks ?? {})[0];
    const devices = doc?.devices ?? {};
    return {
      name: rack?.name,
      chains: rack?.chains.map((c) => c.devices.map((id) => devices[id]?.definitionId ?? "?")),
      sidechains: (doc?.sidechains ?? []).map((e) => ({
        tap: e.from.tap,
        fromHost: e.from.channel === devices[e.to.device]?.channelId,
        target: devices[e.to.device]?.definitionId,
      })),
    };
  });

  expect(patch.name).toBe("Gated Reverb");
  expect(patch.chains).toEqual([[], ["core.reverb", "core.gate"]]);
  // The door is opened by the DRY hit: a same-channel key from `preFx`, which
  // is feed-forward and therefore legal (it is the rule Phase 0 narrowed).
  expect(patch.sidechains).toEqual([{ tap: "preFx", fromHost: true, target: "core.gate" }]);

  // And it is ONE undo entry, routing included.
  await page.getByTestId("undo-button").click();
  const cleared = await page.evaluate(() => {
    const doc = window.__fabletonDemo?.store?.getState();
    return { racks: Object.keys(doc?.racks ?? {}).length, edges: (doc?.sidechains ?? []).length };
  });
  expect(cleared).toEqual({ racks: 0, edges: 0 });
});

test("a gated channel still passes its dry signal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();

  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-factory-rack").selectOption("Gated Reverb");

  const meter = page.locator(`[data-testid="meter-${trackId}"] > div`).first();
  const level = async (): Promise<number> => {
    const h = await meter.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(h === "" ? "0" : h);
  };

  await page.getByRole("button", { name: "Play" }).click();
  // The dry chain is what guarantees this: a gate closing on the wet chain
  // must not take the performance with it.
  await expect
    .poll(level, { timeout: 8_000, message: "the gated channel went silent" })
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop" }).click();
});
