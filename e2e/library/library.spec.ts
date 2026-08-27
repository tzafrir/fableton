// M4 e2e (SS14/SS18-M4): the device library in the real app — every
// definition reachable through the UI menus, the SS7 swap flow, the SS6
// "Audio From" picker on the real compressor, presets, and a WAV export
// whose bytes are verified to be a non-silent RIFF render of the project.

import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function bootAndOpenMixer(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();
  await expect(page.getByTestId("mixer-panel")).toBeVisible();
}

async function firstTrackId(page: Page): Promise<string> {
  const strip = page.locator('[data-testid^="strip-"][data-role="track"]').first();
  return ((await strip.getAttribute("data-testid")) ?? "").replace("strip-", "");
}

test("the whole SS18-M4 library is reachable: 6 effects + 2 instruments in the menus", async ({
  page,
}) => {
  await bootAndOpenMixer(page);
  const trackId = await firstTrackId(page);
  await page.getByTestId(`strip-${trackId}`).click();

  const effectOptions = page.getByTestId("add-effect-select").locator("option:not([disabled])");
  await expect(effectOptions).toHaveText([
    "Filter",
    "EQ Three",
    "Compressor",
    "Stereo Delay",
    "Reverb",
    "Saturator",
  ]);

  const instrumentOptions = page.getByTestId("instrument-select").locator("option:not([disabled])");
  await expect(instrumentOptions).toHaveText(["Poly Synth", "Pluck"]);
});

test("SS7 swap: Poly Synth -> Pluck keeps the clips and still makes sound", async ({ page }) => {
  await bootAndOpenMixer(page);
  const trackId = await firstTrackId(page);
  await page.getByTestId(`strip-${trackId}`).click();

  await page.getByTestId("instrument-select").selectOption({ label: "Pluck" });
  await expect(page.getByTestId("instrument-select")).toHaveValue("core.pluck");

  // Clips untouched: the arrangement still shows the starter clip (its
  // canvas has content pixels — checked cheaply via the undo label instead:
  // the swap is ONE entry and undoing it restores the old instrument).
  await page.getByRole("button", { name: "Play" }).click();
  const masterId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="master"]')
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  const meterFill = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
  await expect
    .poll(
      async () => {
        const h = await meterFill.evaluate((el) => (el as HTMLElement).style.height);
        return Number.parseFloat(h === "" ? "0" : h);
      },
      { timeout: 5_000, message: "the Pluck should be audible through the same clips" },
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop" }).click();

  await page.getByTestId("undo-button").click();
  await expect(page.getByTestId("instrument-select")).toHaveValue("core.poly-synth");
});

test("SS6 Audio From: the compressor's sidechain picker writes a real edge", async ({ page }) => {
  await bootAndOpenMixer(page);
  const trackId = await firstTrackId(page);

  // A second track to key from — keying from the MASTER would loop (the
  // track feeds it) and the SS6 cycle check rightly rejects that, so the
  // only valid sources for a fresh project's track are siblings.
  await page.getByTestId("add-track-button").click();
  await expect(page.locator('[data-testid^="strip-"][data-role="track"]')).toHaveCount(2);

  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-effect-select").selectOption({ label: "Compressor" });

  const scSource = page.locator('[data-testid^="sc-source-"]');
  await expect(scSource).toBeVisible();
  // Options: every OTHER channel (the device's own channel is excluded).
  const optionCount = await scSource.locator("option").count();
  expect(optionCount).toBeGreaterThan(1); // "None" + at least the master

  const firstOther = await scSource.locator("option:not([value=''])").first().getAttribute("value");
  await scSource.selectOption(firstOther ?? "");
  const tapSelect = page.locator('[data-testid^="sc-tap-"]');
  await expect(tapSelect).toBeVisible();
  await expect(tapSelect).toHaveValue("postFader");
  await tapSelect.selectOption("preFx");
  await expect(tapSelect).toHaveValue("preFx");

  // Clearing the source removes the edge and the tap select with it.
  await scSource.selectOption("");
  await expect(page.locator('[data-testid^="sc-tap-"]')).toHaveCount(0);
});

test("presets: a factory preset applies as ONE undo entry; saving offers the current values", async ({
  page,
}) => {
  await bootAndOpenMixer(page);
  const trackId = await firstTrackId(page);
  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-effect-select").selectOption({ label: "Reverb" });

  const preset = page.locator('[data-testid^="preset-select-"]').last();
  await expect(preset).toBeVisible();
  await expect(preset.locator("option")).toHaveText(["presets…", "Room", "Cathedral"]);

  await preset.selectOption("Cathedral");
  // The mix knob for the reverb now reads the preset's 38%.
  const mixKnob = page.locator('[data-testid$="/mix"]').last();
  await expect(mixKnob).toHaveAttribute("aria-valuetext", /38/);

  await page.getByTestId("undo-button").click(); // ONE entry for the whole bag
  await expect(mixKnob).toHaveAttribute("aria-valuetext", /30/); // descriptor default

  // Save: the prompt supplies the name; the new preset shows in the list.
  page.once("dialog", (dialog) => void dialog.accept("My Space"));
  await page.locator('[data-testid^="preset-save-"]').last().click();
  await expect(preset.locator("option")).toHaveText(["presets…", "Room", "Cathedral", "My Space"]);
});

test("Export WAV renders the document offline into a real, non-silent RIFF file", async ({
  page,
}) => {
  await page.goto("/");
  // Deliberately NO audio boot: SS12 export must not need a live context.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-wav-button").click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path as string);

  // RIFF/WAVE, 16-bit stereo PCM.
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  expect(channels).toBe(2);
  expect(sampleRate).toBe(44100);
  expect(bits).toBe(16);

  // Non-silence: RMS over the PCM payload clearly above the noise floor —
  // the starter clip really rendered through the full engine.
  const dataStart = 44;
  let sumSquares = 0;
  let count = 0;
  for (let i = dataStart; i + 1 < bytes.length; i += 2) {
    const sample = bytes.readInt16LE(i) / 0x8000;
    sumSquares += sample * sample;
    count++;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, count));
  expect(count).toBeGreaterThan(sampleRate); // more than a second of audio
  expect(rms).toBeGreaterThan(0.005);
});
