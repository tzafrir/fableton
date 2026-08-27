// Three things a song needs that the app could not do: see which pitch a row
// is, set the transport's loop, and loop a clip without knowing a shortcut.

import { expect, test, type Page } from "@playwright/test";

/** Waits for the app to have mounted its store on the test bridge. Under a
 *  loaded parallel run `goto` resolves before React has, and the bridge then
 *  reads as "no document" rather than as the document it is about to be. */
async function ready(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__fabletonDemo?.store !== undefined), { timeout: 10_000 })
    .toBe(true);
}

/** The live document, through the `--mode e2e` bridge (see src/main.tsx). */
async function loopOf(page: Page): Promise<{ start: number; end: number; enabled: boolean }> {
  return page.evaluate(() => {
    const loop = window.__fabletonDemo?.store?.getState().loop;
    return { start: loop?.start ?? -1, end: loop?.end ?? -1, enabled: loop?.enabled ?? false };
  });
}

test("the piano roll has a key strip naming every row", async ({ page }) => {
  await page.goto("/");
  const gutter = page.locator("canvas.fbl-key-gutter");
  await expect(gutter).toHaveCount(1);

  const shape = await gutter.evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const c = canvas.getContext("2d");
    const data = c?.getImageData(0, 0, canvas.width, canvas.height).data;
    let light = 0;
    let dark = 0;
    for (let i = 0; data !== undefined && i < data.length; i += 4) {
      const r = data[i] ?? 0;
      if (r > 150) light += 1;
      else if (r > 0) dark += 1;
    }
    return { width: Math.round(rect.width), height: Math.round(rect.height), light, dark };
  });

  expect(shape.width, "the strip takes its width out of the editor's").toBe(34);
  expect(shape.height).toBeGreaterThan(50);
  // White keys are light, black keys and labels are dark: both present means
  // it drew a keyboard rather than a blank column.
  expect(shape.light, "white keys").toBeGreaterThan(500);
  expect(shape.dark, "black keys and the labels on them").toBeGreaterThan(100);
});

test("the ruler's top band sets the transport loop; below it still seeks", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  // A new project ships a brace at bars 1-2, switched OFF.
  expect(await loopOf(page)).toEqual({ start: 0, end: 3840, enabled: false });

  const ruler = page.locator(".fbl-arr-ruler");
  const box = await ruler.boundingBox();
  if (box === null) throw new Error("no ruler");
  const band = box.y + 4; // the loop band is the ruler's top 10 css px

  // Drag across EMPTY band (past the existing brace, which ends at x 192):
  // a region drawn on purpose is meant to be used, so this also enables.
  await page.mouse.move(box.x + 400, band);
  await page.mouse.down();
  await page.mouse.move(box.x + 600, band, { steps: 8 });
  await page.mouse.up();

  const drawn = await loopOf(page);
  expect(drawn.enabled).toBe(true);
  expect(drawn.start).toBeGreaterThan(3840);
  expect(drawn.end).toBeGreaterThan(drawn.start);
  // The toolbar toggle and the brace are the same document field.
  await expect(page.getByTestId("loop-toggle")).toHaveAttribute("aria-pressed", "true");

  // Dragging the BODY moves the region and keeps its length — and does not
  // touch the on/off switch, which is what the click below is for.
  await page.mouse.move(box.x + 500, band);
  await page.mouse.down();
  await page.mouse.move(box.x + 560, band, { steps: 6 });
  await page.mouse.up();
  const moved = await loopOf(page);
  expect(moved.end - moved.start).toBe(drawn.end - drawn.start);
  expect(moved.start).toBeGreaterThan(drawn.start);
  expect(moved.enabled).toBe(true);

  // A click (no drag) on the brace toggles looping.
  await page.mouse.click(box.x + 560, band);
  expect((await loopOf(page)).enabled).toBe(false);

  // One undo entry per gesture: click, body drag, then the original drag.
  await page.getByTestId("undo-button").click();
  expect((await loopOf(page)).enabled).toBe(true);
  await page.getByTestId("undo-button").click();
  expect(await loopOf(page)).toEqual(drawn);
  await page.getByTestId("undo-button").click();
  expect(await loopOf(page)).toEqual({ start: 0, end: 3840, enabled: false });

  // Below the band the ruler still seeks, so the two gestures never fight.
  await page.mouse.click(box.x + 400, box.y + 20);
  expect(await loopOf(page)).toEqual({ start: 0, end: 3840, enabled: false });
});

test("Loop Clip loops the selected clip, and undoes", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const button = page.getByTestId("loop-clip-button");
  // Nothing selected: the verb has nothing to act on and says so.
  await expect(button).toBeDisabled();

  const canvas = page.locator('[data-testid="arrangement-panel"] canvas').first();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("no arrangement canvas");
  await page.mouse.click(box.x + 40, box.y + 40); // the starter clip
  await expect(button).toBeEnabled();

  const clipLoops = async (): Promise<number> =>
    page.evaluate(() => {
      const clips = window.__fabletonDemo?.store?.getState().clips ?? {};
      return Object.values(clips).filter((c) => c.loop !== undefined && c.loop !== null).length;
    });
  expect(await clipLoops()).toBe(0);

  await button.click();
  expect(await clipLoops()).toBe(1);
  await page.getByTestId("undo-button").click();
  expect(await clipLoops()).toBe(0);
});
