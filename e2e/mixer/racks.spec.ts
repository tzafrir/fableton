// SS7 racks (plan phases 1-2) end to end: a rack is a chain slot that holds
// parallel chains, and every edit is one undoable document command.

import { expect, test, type Page } from "@playwright/test";

async function trackWithRack(page: Page): Promise<{ trackId: string; rackId: string }> {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByTestId("tab-mixer").click();
  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-rack-button").click();
  const rackId = ((await page.locator('[data-testid^="rack-"].fbl-rack').getAttribute("data-testid")) ?? "").replace(
    "rack-",
    "",
  );
  return { trackId, rackId };
}

test("a rack starts with one chain and takes effects into it", async ({ page }) => {
  const { rackId } = await trackWithRack(page);
  await expect(page.locator(".fbl-rack-chain")).toHaveCount(1);

  const chainId = (
    (await page.locator(".fbl-rack-chain").first().getAttribute("data-testid")) ?? ""
  ).replace(`chain-${rackId}-`, "");
  await page.getByTestId(`chain-add-effect-${rackId}-${chainId}`).selectOption({ label: "Reverb" });
  // The effect lands INSIDE the chain, not on the channel next to the rack.
  await expect(page.locator(`[data-testid="chain-${rackId}-${chainId}"] .fbl-device`)).toHaveCount(1);
  // ...and NOT on the channel beside the rack. (The instrument's panel sits
  // in its own slot column, so the channel chain's direct children are the
  // effect slots alone.)
  await expect(page.locator(".fbl-device-chain > .fbl-device")).toHaveCount(0);
});

test("a second chain runs in parallel, with its own mute and solo", async ({ page }) => {
  const { rackId } = await trackWithRack(page);
  await page.getByTestId(`rack-add-chain-${rackId}`).click();
  await expect(page.locator(".fbl-rack-chain")).toHaveCount(2);

  // Both ids contain dashes ("rack-x9", "rchain-a4"), so the chain id is the
  // remainder after the known prefix — never the last dash-segment.
  const prefix = `chain-${rackId}-`;
  const ids = await page
    .locator(".fbl-rack-chain")
    .evaluateAll(
      (els, p) => els.map((e) => (e.getAttribute("data-testid") ?? "").slice(p.length)),
      prefix,
    );
  const [first, second] = ids as [string, string];
  expect(first).not.toBe(second);

  const mute = page.getByTestId(`chain-mute-${rackId}-${first}`);
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  const solo = page.getByTestId(`chain-solo-${rackId}-${second}`);
  await solo.click();
  await expect(solo).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("undo-button").click();
  await expect(solo).toHaveAttribute("aria-pressed", "false");
  await expect(mute).toHaveAttribute("aria-pressed", "true");
});

test("grouping an existing effect keeps the same device, and ungroup puts it back", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByTestId("tab-mixer").click();
  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-effect-select").selectOption({ label: "Reverb" });

  const deviceId = (
    (await page.locator(".fbl-device-chain > .fbl-device").first().getAttribute("data-testid")) ?? ""
  ).replace("device-", "");

  await page.getByTestId(`device-group-${deviceId}`).click();
  // Same instance id inside the rack — grouping moves an id between lists,
  // it never rebuilds the device (so its values and lanes survive).
  await expect(page.locator(`.fbl-rack-chain [data-testid="device-${deviceId}"]`)).toHaveCount(1);

  const rackId = ((await page.locator(".fbl-rack").getAttribute("data-testid")) ?? "").replace("rack-", "");
  await page.getByTestId(`rack-ungroup-${rackId}`).click();
  await expect(page.locator(".fbl-rack")).toHaveCount(0);
  await expect(page.locator(`.fbl-device-chain > [data-testid="device-${deviceId}"]`)).toHaveCount(1);
});

test("audio flows through a rack, and a muted chain stops contributing", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-mixer").click();
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });

  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-rack-button").click();
  const rackId = ((await page.locator(".fbl-rack").getAttribute("data-testid")) ?? "").replace("rack-", "");
  const chainId = (
    (await page.locator(".fbl-rack-chain").first().getAttribute("data-testid")) ?? ""
  ).replace(`chain-${rackId}-`, "");

  const meter = page.locator(`[data-testid="meter-${trackId}"] > div`).first();
  const level = async (): Promise<number> => {
    const h = await meter.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(h === "" ? "0" : h);
  };

  await page.getByRole("button", { name: "Play" }).click();
  // An empty chain is the DRY path, so the rack passes audio through.
  await expect.poll(level, { timeout: 5_000, message: "a rack must pass audio" }).toBeGreaterThan(0);

  // Its only chain muted, the rack has nothing to sum: the channel goes quiet.
  await page.getByTestId(`chain-mute-${rackId}-${chainId}`).click();
  await expect
    .poll(level, { timeout: 5_000, message: "muting the only chain must silence the rack" })
    .toBeLessThan(1);

  await page.getByRole("button", { name: "Stop" }).click();
});
