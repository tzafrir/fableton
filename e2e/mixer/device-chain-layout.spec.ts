// SS5/SS7 device chain layout.
//
// The device header used to be a single row holding the enable dot, the
// title, the preset picker, save, and ◀ ▶ ✕ — about 224px of controls inside
// a panel whose `minWidth` is 150. One or two effects hid it; with a full
// chain the trailing buttons overflowed their own panel's border and were
// painted over by the NEXT device (later siblings paint on top), so they
// looked like garbage and could not be clicked.
//
// These probes are geometric on purpose: asserting a testid is *visible*
// would not have caught it, because every button was visible — just in the
// wrong place, under its neighbour.

import { expect, test, type Page } from "@playwright/test";

const CHAIN = ["EQ Three", "Compressor", "Reverb", "Filter", "Saturator", "Stereo Delay"];

async function fullChain(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByTestId("tab-mixer").click();
  // Returns widen the strips too, so the mixer half is at its most cramped.
  for (let i = 0; i < 4; i++) await page.getByTestId("add-return-button").click();
  const trackId = (
    (await page.locator('[data-testid^="strip-"][data-role="track"]').first().getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-${trackId}`).click();
  for (const label of CHAIN) await page.getByTestId("add-effect-select").selectOption({ label });
}

test("no device control escapes its own panel, however long the chain", async ({ page }) => {
  await fullChain(page);
  await expect(page.locator(".fbl-device")).toHaveCount(CHAIN.length + 1); // + the instrument

  // Every descendant of a device panel must lie within that panel's box.
  // (Half a pixel of slack for sub-pixel layout at DPR 2.)
  const escapes = await page.evaluate(() => {
    const out: string[] = [];
    for (const host of Array.from(document.querySelectorAll(".fbl-device, .fbl-strip"))) {
      const box = host.getBoundingClientRect();
      for (const child of Array.from(host.querySelectorAll("*"))) {
        const r = child.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5) {
          const who = child.getAttribute("data-testid") ?? child.tagName;
          out.push(`${host.getAttribute("data-testid") ?? host.className} / ${who}`);
        }
      }
    }
    return out;
  });
  expect(escapes, "controls spilling outside their panel overlap the next one").toEqual([]);
});

test("the first effect's buttons are still clickable with a full chain behind it", async ({ page }) => {
  await fullChain(page);
  const first = page.locator(".fbl-device").nth(1); // [0] is the instrument
  const deviceId = ((await first.getAttribute("data-testid")) ?? "").replace("device-", "");

  // Playwright's hit-target check is the assertion here: an overflowing
  // button sits UNDER the next device panel, so this click would land on the
  // neighbour instead (or time out) rather than removing the device.
  await page.getByTestId(`device-right-${deviceId}`).click();
  await expect(page.locator(".fbl-device").nth(2)).toHaveAttribute("data-testid", `device-${deviceId}`);

  await page.getByTestId(`device-remove-${deviceId}`).click();
  await expect(page.locator(".fbl-device")).toHaveCount(CHAIN.length);
  await expect(page.getByTestId(`device-${deviceId}`)).toHaveCount(0);
});
