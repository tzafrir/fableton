// M3 e2e (SS11/SS18-M3): automation against the real app — lane creation
// from the registry menu, point editing on the kit canvas, moving-knob
// display during playback, and the SS4 override / re-enable cycle.

import { expect, test, type Page } from "@playwright/test";
import { scanColorRects, type ColorRect } from "../interaction/editing-helpers";

/** The lane editor's point fill (src/editor/automation/view.ts THEME). */
const POINT_FILL: readonly [number, number, number] = [0xdd, 0xee, 0xff];

async function bootAndOpenAutomation(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-automation").click();
  await expect(page.getByTestId("automation-panel")).toBeVisible();
}

async function addVolumeLane(page: Page): Promise<string> {
  const select = page.getByTestId("add-lane-select");
  await expect(select).toBeEnabled();
  const value = await select
    .locator("option")
    .filter({ hasText: /^vol — Volume/ })
    .first()
    .getAttribute("value");
  if (value === null) throw new Error("no volume param in the lane menu");
  await select.selectOption(value);
  const row = page.locator('[data-testid^="lane-row-"]');
  await expect(row).toHaveCount(1);
  return value;
}

async function scanPoints(page: Page): Promise<ColorRect[]> {
  return scanColorRects(page, "automation-lane-editor", "content", POINT_FILL, {
    tolerance: 20,
    minAreaDevicePx: 8,
  });
}

test("the lane menu is a filtered view of the registry; adding creates an enabled lane", async ({
  page,
}) => {
  await bootAndOpenAutomation(page);
  const select = page.getByTestId("add-lane-select");
  const options = select.locator("option");
  // Mixer params AND the track's device params are all offered (SS11).
  await expect(options.filter({ hasText: /^vol — Volume/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /^pan — Pan/ })).toHaveCount(1);
  await expect(options.filter({ hasText: "cutoff" }).first()).toBeAttached();

  await addVolumeLane(page);
  const enabled = page.locator('[data-testid^="lane-enabled-"]');
  await expect(enabled).toBeChecked();
});

test("double-click creates the first point; a segment click adds another; drag moves one; undo steps back", async ({
  page,
}) => {
  await bootAndOpenAutomation(page);
  await addVolumeLane(page);
  const editor = page.getByTestId("automation-lane-editor");
  const box = (await editor.boundingBox())!;

  // Double-click empty lane: first point.
  await page.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.4);
  await expect.poll(async () => (await scanPoints(page)).length).toBe(1);

  // The curve now spans the lane; click it far to the right to add a point.
  const first = (await scanPoints(page))[0] as ColorRect;
  await page.mouse.click(box.x + box.width * 0.6, first.pageCenterY);
  await expect.poll(async () => (await scanPoints(page)).length).toBe(2);

  // Drag the second point downward: ONE undo entry, position changes.
  const before = await scanPoints(page);
  const target = before[1] as ColorRect;
  await page.mouse.move(target.pageCenterX, target.pageCenterY);
  await page.mouse.down();
  await page.mouse.move(target.pageCenterX + 40, target.pageCenterY + 25, { steps: 8 });
  await page.mouse.up();
  const after = await scanPoints(page);
  expect(after.length).toBe(2);
  expect(Math.abs((after[1] as ColorRect).y - target.y)).toBeGreaterThan(10);

  await page.getByTestId("undo-button").click(); // undo the move only
  const undone = await scanPoints(page);
  expect(Math.abs((undone[1] as ColorRect).y - target.y)).toBeLessThan(3);
});

test("playback drives the lane: the fader's live value moves; grabbing it overrides; Re-enable restores", async ({
  page,
}) => {
  await bootAndOpenAutomation(page);
  const paramId = await addVolumeLane(page);
  const editor = page.getByTestId("automation-lane-editor");
  const box = (await editor.boundingBox())!;

  // Two points: loud at the start, quiet later — a clearly moving lane.
  await page.mouse.dblclick(box.x + box.width * 0.05, box.y + box.height * 0.15);
  await expect.poll(async () => (await scanPoints(page)).length).toBe(1);
  const first = (await scanPoints(page))[0] as ColorRect;
  await page.mouse.click(box.x + box.width * 0.7, first.pageCenterY);
  await expect.poll(async () => (await scanPoints(page)).length).toBe(2);
  const second = (await scanPoints(page))[1] as ColorRect;
  await page.mouse.move(second.pageCenterX, second.pageCenterY);
  await page.mouse.down();
  await page.mouse.move(second.pageCenterX, box.y + box.height * 0.85, { steps: 6 });
  await page.mouse.up();

  // The mixer's fader for the same param shows the moving value.
  const trackId = paramId.replace("chan:", "").replace("/vol", "");
  await page.getByTestId("tab-mixer").click();
  const fader = page.getByTestId(`vol-${trackId}`);
  await expect(fader).toBeVisible();

  await page.getByRole("button", { name: "Play" }).click();
  const v1 = await fader.getAttribute("aria-valuetext");
  await expect
    .poll(async () => fader.getAttribute("aria-valuetext"), {
      timeout: 5_000,
      message: "the moving knob should track the lane during playback",
    })
    .not.toBe(v1);

  // SS4 override: touching the automated fader suspends its lane...
  const fbox = (await fader.boundingBox())!;
  await page.mouse.move(fbox.x + fbox.width / 2, fbox.y + fbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fbox.x + fbox.width / 2, fbox.y + fbox.height / 2 - 10, { steps: 4 });
  await page.mouse.up();
  const pill = page.getByTestId("reenable-automation");
  await expect(pill).toBeEnabled(); // lights: hasOverrides

  // ...and Re-enable hands it back.
  await pill.click();
  await expect(pill).toBeDisabled();
  await page.getByRole("button", { name: "Stop" }).click();
});

test("disabling the lane frees the param; deleting the device keeps the lane greyed and re-bindable", async ({
  page,
}) => {
  await bootAndOpenAutomation(page);
  // Automate the instrument's cutoff (a DEVICE param).
  const select = page.getByTestId("add-lane-select");
  const cutoff = await select
    .locator("option")
    .filter({ hasText: "cutoff" })
    .first()
    .getAttribute("value");
  await select.selectOption(cutoff ?? "");
  const row = page.locator('[data-testid^="lane-row-"]');
  await expect(row).toHaveCount(1);

  // Disable: data kept, inert (SS11).
  const enabled = page.locator('[data-testid^="lane-enabled-"]');
  await enabled.uncheck();
  await expect(enabled).not.toBeChecked();

  // Swap the instrument away and back off the mixer's chain panel: the lane
  // survives (SS7 "kept, greyed, re-bindable"), shown greyed with a re-bind
  // select once its param id no longer matches a live handle.
  await page.getByTestId("tab-mixer").click();
  const instrument = page.getByTestId("instrument-select");
  await expect(instrument).toBeVisible();
  // The only instrument definition is the poly synth; swapping to ITSELF
  // still mints a new instance id, which orphans the old param path.
  await instrument.selectOption({ index: 1 });
  await page.getByTestId("tab-automation").click();
  await expect(page.locator('[data-testid^="lane-row-"]')).toHaveCount(1);
  const rebind = page.locator('[data-testid^="lane-rebind-"]');
  await expect(rebind).toBeVisible();

  // Re-bind it to the NEW instance's cutoff in two clicks (SS7).
  const newCutoff = await rebind.locator("option").filter({ hasText: "cutoff" }).first().getAttribute("value");
  await rebind.selectOption(newCutoff ?? "");
  await expect(page.locator('[data-testid^="lane-rebind-"]')).toHaveCount(0); // live again
});
