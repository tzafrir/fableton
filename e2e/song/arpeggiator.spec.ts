import { expect, test, type Page } from "@playwright/test";
import {
  ARR_CLIP_FILL,
  NOTE_FILL,
  scanColorRects,
  scanNotes,
  type ColorRect,
} from "../interaction/editing-helpers";

// The arpeggiator, through the UI it is actually reached by: select notes in
// the roll, open the dialog, apply, look at the notes that came out. The
// pattern math is covered headlessly in src/state/arpeggio.test.ts; this is
// about the wiring — the toolbar's enablement, the selection the dialog acts
// on, and the single undo entry.

async function openStarterClip(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();
  // The clip is found by its own pixels rather than by a guessed coordinate:
  // the lane header column takes the left of the panel, and its width is not
  // this suite's business.
  const clips = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 40,
  });
  expect(clips.length, "expected the fresh project's one clip to render").toBeGreaterThan(0);
  const clip = clips[0] as ColorRect;
  await page.mouse.dblclick(clip.pageCenterX, clip.pageCenterY);
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();
}

/** The roll's own note area: below the ruler, above the velocity lane
 *  (src/editor/pianoroll/layout.ts). Same measurements the piano-roll
 *  interaction suite uses. */
const RULER_HEIGHT_PX = 20;
const VELOCITY_LANE_HEIGHT_PX = 72;

/** Draws `count` notes stacked at the same time position — a chord, which is
 *  what an arpeggiator is for. */
async function drawChord(page: Page, count: number): Promise<void> {
  const box = await page.getByTestId("piano-roll-panel").boundingBox();
  expect(box).toBeTruthy();
  const x = box!.x + box!.width * 0.15;
  const top = box!.y + RULER_HEIGHT_PX + 10;
  const bottom = box!.y + box!.height - VELOCITY_LANE_HEIGHT_PX - 10;
  const spacing = Math.max(18, Math.floor((bottom - top) / (count + 1)));
  for (let i = 0; i < count; i++) {
    await page.mouse.dblclick(x, top + spacing * (i + 1));
  }
  await expect.poll(async () => (await scanNotes(page, NOTE_FILL)).length).toBe(count);
}

test("arpeggiating a chord replaces it, and one undo brings it back", async ({ page }) => {
  await openStarterClip(page);

  // Nothing selected: the verb is offered but not available.
  await expect(page.getByTestId("arpeggiate-button")).toBeDisabled();

  // A 1/4-note grid, so each drawn note is a quarter long and a 1/16 arp has
  // four steps to make out of it. At the adaptive grid the roll opens with,
  // the chord would be one step wide and the arpeggio one note — correct,
  // and useless as a test.
  await page.getByTestId("grid-select").selectOption("4");
  await drawChord(page, 3);
  await page.keyboard.press("Control+a"); // select every note in the clip
  await expect(page.getByTestId("arpeggiate-button")).toBeEnabled();

  await page.getByTestId("arpeggiate-button").click();
  await expect(page.getByTestId("arp-dialog")).toBeVisible();
  await expect(page.getByTestId("arp-selection")).toHaveText("3 notes selected");

  await page.getByTestId("arp-rate").selectOption("240");
  await page.getByTestId("arp-apply").click();
  await expect(page.getByTestId("arp-dialog")).toBeHidden();

  // The chord's three stacked notes became a run of shorter ones.
  const after = await scanNotes(page, NOTE_FILL);
  expect(after.length).toBeGreaterThan(3);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await scanNotes(page, NOTE_FILL)).length).toBe(3);
});

test("Escape closes the dialog without touching the notes", async ({ page }) => {
  await openStarterClip(page);
  await drawChord(page, 2);
  await page.keyboard.press("Control+a");
  await page.getByTestId("arpeggiate-button").click();
  await expect(page.getByTestId("arp-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("arp-dialog")).toBeHidden();
  expect((await scanNotes(page, NOTE_FILL)).length).toBe(2);
});
