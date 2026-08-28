import { expect, test } from "@playwright/test";
import { bootAudio } from "./helpers";

// Not an assertion suite — a design review harness. It drives the app into
// the three states worth LOOKING at and writes full-page screenshots, so a
// palette or spacing change can be judged as a whole instead of one panel at
// a time. Kept out of the default run by its `@design` tag.
test.describe("@design", () => {
  test("captures the shell, the mixer and a rack", async ({ page }) => {
    await page.setViewportSize({ width: 1560, height: 900 });
    await page.goto("/");
    await bootAudio(page);
    await page.screenshot({ path: ".playwright/design/01-arrangement.png", fullPage: true });

    // Open the starter clip in the piano roll.
    const arrangement = page.getByTestId("arrangement-panel");
    const box = await arrangement.boundingBox();
    if (box === null) throw new Error("no arrangement box");
    await page.mouse.dblclick(box.x + 132 + 20, box.y + 26 + 28);
    await page.screenshot({ path: ".playwright/design/02-pianoroll.png", fullPage: true });

    await page.getByTestId("tab-mixer").click();
    await page.getByTestId("add-return-button").click();
    await page.getByTestId("add-track-button").click();
    await page.getByTestId("add-track-button").click();
    await expect(page.getByTestId("mixer-panel")).toBeVisible();
    await page.screenshot({ path: ".playwright/design/03-mixer.png", fullPage: true });
    await page.getByTestId("mixer-panel").screenshot({ path: ".playwright/design/03b-mixer-only.png" });

    // A channel with a real chain: instrument + three effects + a rack.
    await page.getByTestId("strip-name-" + (await firstTrackId(page))).click();
    for (const id of ["core.filter", "core.stereo-delay", "core.reverb"]) {
      await page.getByTestId("add-effect-select").selectOption(id);
    }
    await page.getByTestId("add-factory-rack").selectOption("Gated Reverb");
    await page.waitForTimeout(400);
    await page.screenshot({ path: ".playwright/design/04-devices.png", fullPage: true });
    await page.getByTestId("device-chain-panel").screenshot({ path: ".playwright/design/04b-devices-only.png" });
    await page.getByTestId("toolbar").screenshot({ path: ".playwright/design/06-toolbar.png" });

    await page.getByTestId("tab-automation").click();
    await page.screenshot({ path: ".playwright/design/05-automation.png", fullPage: true });

    // The narrow case: 1280 is where the toolbar has the least room, so it
    // is where a wrapped group or a clipped readout would show first.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId("tab-mixer").click();
    await page.screenshot({ path: ".playwright/design/07-narrow.png", fullPage: true });

    await page.setViewportSize({ width: 1560, height: 950 });
    await page.getByTestId("shortcuts-button").click();
    await page.getByTestId("shortcuts-overlay").screenshot({
      path: ".playwright/design/08-shortcuts.png",
    });
  });
});

async function firstTrackId(page: import("@playwright/test").Page): Promise<string> {
  const strip = page.locator('[data-testid^="strip-"][data-role="track"]').first();
  const id = await strip.getAttribute("data-testid");
  return (id ?? "").replace("strip-", "");
}
