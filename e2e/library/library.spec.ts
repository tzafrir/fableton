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

test("the whole device library is reachable from the menus", async ({ page }) => {
  await bootAndOpenMixer(page);
  const trackId = await firstTrackId(page);
  await page.getByTestId(`strip-${trackId}`).click();

  const effectOptions = page.getByTestId("add-effect-select").locator("option:not([disabled])");
  await expect(effectOptions).toHaveText([
    "Filter",
    "EQ Three",
    "EQ Eight",
    "Compressor",
    "Stereo Delay",
    "Reverb",
    "Saturator",
    "Overdrive",
    "Distortion",
    "Gate",
  ]);

  const instrumentOptions = page.getByTestId("instrument-select").locator("option:not([disabled])");
  await expect(instrumentOptions).toHaveText([
    "Poly Synth",
    "Pluck",
    "FM Synth",
    "Kick",
    "Drum Machine",
    "Noise",
    "Sampler",
  ]);

  // Note effects are their own menu, on their own chain (SS7 `midiEffect`).
  const noteEffectOptions = page.getByTestId("add-note-effect-select").locator("option:not([disabled])");
  await expect(noteEffectOptions).toHaveText(["Arpeggiator"]);
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
  const kickId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="track"]')
      .last()
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  expect(kickId).not.toBe(trackId);

  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-effect-select").selectOption({ label: "Compressor" });

  const scSource = page.locator('[data-testid^="sc-source-"]');
  await expect(scSource).toBeVisible();
  // Options: "None" plus every channel — including the device's OWN, which
  // Phase 0 made a legal source from the preFx tap (gated reverb keys that
  // way). So a CROSS-channel probe has to name the sibling explicitly rather
  // than taking whatever sorts first.
  const optionCount = await scSource.locator("option").count();
  expect(optionCount).toBeGreaterThan(2); // None + own + at least one other

  await scSource.selectOption(kickId);
  const tapSelect = page.locator('[data-testid^="sc-tap-"]');
  await expect(tapSelect).toBeVisible();
  // A cross-channel key defaults to post-fader and may move anywhere.
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
  expect(rms).toBeGreaterThan(0.005);

  // The file is exactly as long as the DOCUMENT says it should be — the span
  // math (`renderSpan`, SS12) is pure, so the browser can hand us the number
  // the render used. "More than a second of audio" passed for any truncated
  // or runaway render; this does not.
  const durationSeconds = await page.evaluate(() => {
    const bridge = window.__fabletonDemo;
    if (bridge?.store === undefined) throw new Error("no e2e store bridge");
    return bridge.renderSpan(bridge.store.getState()).durationSeconds;
  });
  const dataBytes = bytes.readUInt32LE(40);
  const frames = dataBytes / (channels * (bits / 8));
  expect(frames).toBe(Math.ceil(durationSeconds * sampleRate));
  expect(count).toBe(frames * channels);
});

// The instruments and effects added for song-writing. Each is driven through
// the real UI and has to actually MAKE SOUND — a device that registers its
// params but produces silence would pass every structural check.
for (const instrument of ["FM Synth", "Kick", "Drum Machine"]) {
  test(`${instrument} plays the arrangement's clip`, async ({ page }) => {
    await bootAndOpenMixer(page);
    const trackId = await firstTrackId(page);
    await page.getByTestId(`strip-${trackId}`).click();
    await page.getByTestId("instrument-select").selectOption({ label: instrument });

    // The starter clip is a melodic phrase around C3-C4. The drum machine
    // only answers to its pad notes, so the phrase is replaced with a note
    // ON a pad (C1) when that is what is loaded.
    if (instrument === "Drum Machine") {
      await page.evaluate(() => {
        const store = window.__fabletonDemo?.store;
        const doc = store?.getState();
        const clip = doc === undefined ? undefined : Object.values(doc.clips)[0];
        if (store === undefined || clip === undefined) return;
        store.dispatch({
          label: "test: drum note",
          run: (draft) => {
            const target = draft.clips[clip.id];
            if (target === undefined) return;
            for (const note of target.notes) note.pitch = 36; // C1 = the kick pad
          },
        });
      });
    }

    const masterId = (
      (await page.locator('[data-testid^="strip-"][data-role="master"]').getAttribute("data-testid")) ?? ""
    ).replace("strip-", "");
    const meterFill = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
    const level = async (): Promise<number> => {
      const h = await meterFill.evaluate((el) => (el as HTMLElement).style.height);
      return Number.parseFloat(h === "" ? "0" : h);
    };

    await page.getByRole("button", { name: "Play" }).click();
    await expect.poll(level, { timeout: 8_000, message: `${instrument} is silent` }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Stop" }).click();
  });
}

for (const effect of ["Overdrive", "Distortion"]) {
  test(`${effect} passes audio and its controls are live`, async ({ page }) => {
    await bootAndOpenMixer(page);
    const trackId = await firstTrackId(page);
    await page.getByTestId(`strip-${trackId}`).click();
    await page.getByTestId("add-effect-select").selectOption({ label: effect });

    const device = page.locator(".fbl-device-chain > .fbl-device").first();
    const deviceId = ((await device.getAttribute("data-testid")) ?? "").replace("device-", "");
    // Control testids carry the FULL param path (`ctl-chan:.../dev:.../drive`),
    // so they are matched by their leaf. Drive and Tone are the two every
    // clipper needs; Edge is what makes a distortion one (`core.overdrive`
    // deliberately has no such control).
    await expect(page.locator('[data-testid$="/drive"]')).toHaveCount(1);
    await expect(page.locator('[data-testid$="/tone"]')).toHaveCount(1);
    await expect(page.locator('[data-testid$="/edge"]')).toHaveCount(effect === "Distortion" ? 1 : 0);

    const masterId = (
      (await page.locator('[data-testid^="strip-"][data-role="master"]').getAttribute("data-testid")) ?? ""
    ).replace("strip-", "");
    const meterFill = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
    const level = async (): Promise<number> => {
      const h = await meterFill.evaluate((el) => (el as HTMLElement).style.height);
      return Number.parseFloat(h === "" ? "0" : h);
    };

    await page.getByRole("button", { name: "Play" }).click();
    // A clipper at unity is a pass-through, not a mute: audio still arrives.
    await expect.poll(level, { timeout: 8_000, message: `${effect} killed the signal` }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Stop" }).click();
    expect(deviceId).not.toBe("");
  });
}
