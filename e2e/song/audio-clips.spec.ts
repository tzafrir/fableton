import { expect, test, type Page } from "@playwright/test";
import { ARR_CLIP_FILL, scanColorRects, type ColorRect } from "../interaction/editing-helpers";

// Audio clips on the timeline, through the UI they are reached by: import a
// wav, see it land on the selected track at the playhead, drag it, and have
// it survive a reload. The scheduling math is covered headlessly in
// src/engine/audioclips/scheduler.test.ts.

/** A short 16-bit mono PCM WAV — real enough for `decodeAudioData`. */
function wavBytes(seconds = 0.5, sampleRate = 8000): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 14000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
}

/**
 * Clip pixels currently drawn in the arrangement.
 *
 * NOTE these are REGIONS of clip fill, not clips: an audio clip's waveform is
 * drawn on top of its body in another colour, so one audio clip yields
 * several fill regions. Every assertion below is therefore about WHERE clip
 * pixels are, never about how many regions there are.
 */
async function clipRects(page: Page): Promise<ColorRect[]> {
  return scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 40,
  });
}

/** The right-hand edge of everything drawn — the starter clip ends here
 *  until something is added past it. */
async function rightEdge(page: Page): Promise<number> {
  const rects = await clipRects(page);
  return rects.reduce((max, r) => Math.max(max, r.pageX + r.w), 0);
}

/** Puts the playhead a few bars in, by clicking the arrangement's ruler —
 *  which is where a new audio clip lands. */
async function seekIntoTheSong(page: Page): Promise<number> {
  // The ruler has its own element, and its top ~10 px are the loop band —
  // below that it seeks (see e2e/song/loops-and-keys.spec.ts).
  const ruler = page.locator(".fbl-arr-ruler");
  const box = await ruler.boundingBox();
  expect(box).toBeTruthy();
  const x = box!.x + box!.width * 0.45;
  const playhead = page.locator('[data-testid="arrangement-panel"] .fbl-playhead');
  const before = await playhead.evaluate((el) => (el as HTMLElement).style.transform);
  await page.mouse.click(x, box!.y + 20);
  // The seek is what puts a new audio clip where it goes, so assert it
  // landed rather than assuming the ruler was where the click went.
  await expect
    .poll(async () => playhead.evaluate((el) => (el as HTMLElement).style.transform))
    .not.toBe(before);
  return x;
}

async function addTake(page: Page, name = "take.wav"): Promise<void> {
  await page.getByTestId("add-audio-file").setInputFiles({
    name,
    mimeType: "audio/wav",
    buffer: wavBytes(),
  });
  await expect(page.getByTestId("toolbar-status-message")).toHaveText(
    new RegExp(`Added ${name.replace(".", "\\.")}`),
  );
}

test("adding a wav puts a clip at the playhead, and it survives a reload", async ({ page }) => {
  await boot(page);
  const before = await rightEdge(page);
  const playheadX = await seekIntoTheSong(page);
  expect(playheadX).toBeGreaterThan(before);

  await addTake(page);

  // Clip pixels now reach past where the starter clip ended, at the playhead.
  await expect.poll(async () => rightEdge(page)).toBeGreaterThan(playheadX - 10);

  await expect(page.getByTestId("autosave-status")).toHaveText("Saved", { timeout: 10_000 });
  await page.reload();
  await expect.poll(async () => rightEdge(page)).toBeGreaterThan(playheadX - 10);
});

test("an audio clip drags like any other clip, and undo puts it back", async ({ page }) => {
  await boot(page);
  await seekIntoTheSong(page);
  await addTake(page);
  const before = await rightEdge(page);

  // Grab it by a pixel that is unambiguously inside it: just right of the
  // playhead, on the first lane.
  const rects = await clipRects(page);
  const grab = rects.reduce((best, r) => (r.pageX > best.pageX ? r : best), rects[0] as ColorRect);
  await page.mouse.move(grab.pageCenterX, grab.pageCenterY);
  await page.mouse.down();
  await page.mouse.move(grab.pageCenterX + 160, grab.pageCenterY, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => rightEdge(page)).toBeGreaterThan(before + 50);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => rightEdge(page)).toBeLessThan(before + 20);
});

test("double-clicking an audio clip does not swap the piano roll onto it", async ({ page }) => {
  await boot(page);
  // Open the MIDI clip first, so there is something in the roll to lose.
  const midi = (await clipRects(page))[0] as ColorRect;
  await page.mouse.dblclick(midi.pageCenterX, midi.pageCenterY);
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();

  await seekIntoTheSong(page);
  await addTake(page);
  const rects = await clipRects(page);
  const audio = rects.reduce((best, r) => (r.pageX > best.pageX ? r : best), rects[0] as ColorRect);

  await page.mouse.dblclick(audio.pageCenterX, audio.pageCenterY);
  // Still showing the roll for the MIDI clip: an audio clip has no notes, so
  // swapping to it would only lose the user's place.
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();
});

// The proof that matters: an audio clip is not just a rectangle. With the
// project's own MIDI clip deleted, the ONLY thing that can move the master
// meter is the wav.
test("an audio clip actually sounds", async ({ page }) => {
  await boot(page);

  // Delete the starter MIDI clip, so nothing else can be making the noise.
  const midi = (await clipRects(page))[0] as ColorRect;
  await page.mouse.click(midi.pageCenterX, midi.pageCenterY);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await clipRects(page)).length).toBe(0);

  // A long take at the very start, so playback runs straight into it.
  await page.getByTestId("add-audio-file").setInputFiles({
    name: "tone.wav",
    mimeType: "audio/wav",
    buffer: wavBytes(4),
  });
  await expect(page.getByTestId("toolbar-status-message")).toHaveText(/Added tone\.wav/);

  await page.getByTestId("tab-mixer").click();
  const masterStrip = page.locator('[data-testid^="strip-"][data-role="master"]');
  const masterId = (await masterStrip.getAttribute("data-testid"))!.replace("strip-", "");
  const meterLevel = async (): Promise<number> => {
    const bar = page.getByTestId(`meter-${masterId}`).locator("div").first();
    const height = await bar.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(height) || 0;
  };

  await expect.poll(meterLevel, { timeout: 3_000 }).toBeLessThan(0.5);
  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(meterLevel, { timeout: 10_000, message: "the wav should be reaching the master bus" })
    .toBeGreaterThan(1);
});
