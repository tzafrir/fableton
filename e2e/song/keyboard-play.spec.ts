// The computer keyboard as an instrument, and Rec as the way what you play
// becomes part of the song.

import { expect, test, type Page } from "@playwright/test";

async function bootedApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.__fabletonDemo?.store !== undefined), { timeout: 10_000 })
    .toBe(true);
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
}

/** Every note in the document, as `pitch@start` strings. */
async function notes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const clips = window.__fabletonDemo?.store?.getState().clips ?? {};
    return Object.values(clips).flatMap((clip) =>
      clip.notes.map((note) => `${String(note.pitch)}@${String(clip.start + note.start)}`),
    );
  });
}

test("the home row plays the selected track's instrument", async ({ page }) => {
  await bootedApp(page);
  // Meters live in the mixer panel, so it has to be the open tab.
  await page.getByTestId("tab-mixer").click();
  const masterId = (
    (await page.locator('[data-testid^="strip-"][data-role="master"]').getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  const meter = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
  const level = async (): Promise<number> => {
    const h = await meter.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(h === "" ? "0" : h);
  };

  // Nothing is playing: any level has to come from the key press itself.
  expect(await level()).toBe(0);
  await page.keyboard.down("a");
  await expect.poll(level, { timeout: 5_000, message: "pressing `a` must sound C" }).toBeGreaterThan(0);
  await page.keyboard.up("a");
});

test("z / x shift the octave and the readout follows", async ({ page }) => {
  await bootedApp(page);
  const readout = page.getByTestId("keyboard-readout");
  await expect(readout).toContainText("Oct 3");
  await page.keyboard.press("x");
  await expect(readout).toContainText("Oct 4");
  await page.keyboard.press("z");
  await page.keyboard.press("z");
  await expect(readout).toContainText("Oct 2");
  await page.keyboard.press("v");
  await expect(readout).toContainText("Vel 115");
});

test("typing in a field is typing, not playing", async ({ page }) => {
  await bootedApp(page);
  const name = page.getByTestId("project-name-input");
  await name.click();
  await name.fill("");
  await page.keyboard.type("adhoc");
  // The letters land in the field, the octave is untouched, and no note plays.
  await expect(name).toHaveValue("adhoc");
  await expect(page.getByTestId("keyboard-readout")).toContainText("Oct 3");
});

test("Rec captures what is played, and Stop commits it as one undo entry", async ({ page }) => {
  await bootedApp(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const before = await notes(page);

  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("record-button")).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.down("a");
  await page.waitForTimeout(150);
  await page.keyboard.up("a");
  await page.keyboard.down("g");
  await page.waitForTimeout(150);
  await page.keyboard.up("g");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("record-button")).toHaveAttribute("aria-pressed", "false");

  const after = await notes(page);
  expect(after.length).toBe(before.length + 2);
  // C3 and G3 — the keys that were pressed, at the pitches the layout says.
  expect(after.some((n) => n.startsWith("60@"))).toBe(true);
  expect(after.some((n) => n.startsWith("67@"))).toBe(true);

  // One take, one entry: undo returns the document to where it started.
  await page.getByTestId("undo-button").click();
  expect(await notes(page)).toEqual(before);
});
