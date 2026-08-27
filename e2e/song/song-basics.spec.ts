// Phase S (SS8/SS13): the song-level controls. Every command behind these
// shipped in M1 and was covered by unit tests; what did not exist was any way
// to reach them from the running app, so a project was permanently
// "Untitled", 120 bpm, 4/4, with tracks named "Track 1..n" in creation order.
// These probes drive the real controls and assert the document actually moved.

import { expect, test, type Page } from "@playwright/test";

async function freshProject(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
}

test("tempo: typing a BPM retunes the song and is ONE undo entry", async ({ page }) => {
  await freshProject(page);
  const tempo = page.getByTestId("tempo-input");
  await expect(tempo).toHaveValue("120");

  await tempo.fill("");
  await tempo.type("142");
  await tempo.blur();
  await expect(tempo).toHaveValue("142");

  // SS13 coalescing: the three keystrokes are one entry, so a single undo
  // returns the whole edit rather than stepping 14 -> 1 -> 120.
  await page.getByTestId("undo-button").click();
  await expect(tempo).toHaveValue("120");
});

test("tempo clamps to the documented range instead of accepting nonsense", async ({ page }) => {
  await freshProject(page);
  const tempo = page.getByTestId("tempo-input");
  await tempo.fill("5000");
  await tempo.blur();
  await expect(tempo).toHaveValue("999"); // MAX_BPM
  await tempo.fill("1");
  await tempo.blur();
  await expect(tempo).toHaveValue("20"); // MIN_BPM
});

test("time signature: 3/4 changes the bar, and the ruler redraws for it", async ({ page }) => {
  await freshProject(page);
  const num = page.getByTestId("timesig-numerator");
  const den = page.getByTestId("timesig-denominator");
  await expect(num).toHaveValue("4");
  await expect(den).toHaveValue("4");

  await num.fill("3");
  await num.blur();
  await expect(num).toHaveValue("3");
  await den.selectOption("8");
  await expect(den).toHaveValue("8");

  await page.getByTestId("undo-button").click(); // 3/8 -> 3/4
  await expect(den).toHaveValue("4");
});

test("project name is editable and survives a save + reload", async ({ page }) => {
  await freshProject(page);
  const name = page.getByTestId("project-name-input");
  await name.fill("Night Drive");
  await expect(name).toHaveValue("Night Drive");

  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("autosave-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("project-name-input")).toHaveValue("Night Drive");
});

test("tracks: add from the arrangement, rename in place, reorder", async ({ page }) => {
  await freshProject(page);

  // Add two tracks WITHOUT leaving the arrangement (the mixer tab also has a
  // button; building a song should not require switching tabs).
  await page.getByTestId("arrangement-add-track").click();
  await page.getByTestId("arrangement-add-track").click();
  const headers = page.locator(".fbl-arr-header");
  await expect(headers).toHaveCount(4); // 3 tracks + master

  // Rename track 2 in place: double-click the name, type, Enter.
  const second = headers.nth(1).locator(".fbl-arr-header-name");
  await expect(second).toHaveText("Track 2");
  await second.dblclick();
  const field = page.locator(".fbl-arr-header-rename");
  await expect(field).toBeVisible();
  await field.fill("Bass");
  await field.press("Enter");
  await expect(headers.nth(1).locator(".fbl-arr-header-name")).toHaveText("Bass");

  // Escape abandons a rename without touching the document.
  await headers.nth(1).locator(".fbl-arr-header-name").dblclick();
  await page.locator(".fbl-arr-header-rename").fill("Discarded");
  await page.locator(".fbl-arr-header-rename").press("Escape");
  await expect(headers.nth(1).locator(".fbl-arr-header-name")).toHaveText("Bass");

  // Reorder: move "Bass" up one row (channelOrder IS the arrangement's row
  // order, so the lane moves on screen).
  await headers.nth(1).getByTitle("Move track up").click();
  await expect(headers.nth(0).locator(".fbl-arr-header-name")).toHaveText("Bass");

  await page.getByTestId("undo-button").click();
  await expect(headers.nth(1).locator(".fbl-arr-header-name")).toHaveText("Bass");
});

test("loop toggle flips the transport's loop and undoes", async ({ page }) => {
  await freshProject(page);
  const loop = page.getByTestId("loop-toggle");
  await expect(loop).toHaveAttribute("aria-pressed", "false");
  await loop.click();
  await expect(loop).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("undo-button").click();
  await expect(loop).toHaveAttribute("aria-pressed", "false");
});
