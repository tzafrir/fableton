import { expect, test, type Page } from "@playwright/test";

// The sampler, end to end: import a real audio file through the panel's own
// file input, and prove the whole chain the import touches — decode, byte
// store, document — actually holds. This is the one that cannot be a unit
// test: `decodeAudioData` and OPFS are the two halves the fakes stand in for.

/** A minimal 16-bit mono PCM WAV of a 440 Hz sine — small enough to inline,
 *  real enough for `decodeAudioData` to accept. */
function wavBytes(seconds = 0.25, sampleRate = 8000): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function bootAndSelectSampler(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();
  await page.getByTestId("instrument-select").selectOption({ label: "Sampler" });
  const deviceId = await page
    .getByTestId(/^sample-select-/)
    .first()
    .evaluate((el) => el.getAttribute("data-testid")?.replace("sample-select-", "") ?? "");
  expect(deviceId).not.toBe("");
  return deviceId;
}

test("importing a wav puts it in the document and selects it in the slot", async ({ page }) => {
  const deviceId = await bootAndSelectSampler(page);

  const slot = page.getByTestId(`sample-select-${deviceId}`);
  await expect(slot).toHaveValue("");
  await expect(slot.locator("option")).toHaveText(["No sample"]);

  await page.getByTestId(`sample-file-${deviceId}`).setInputFiles({
    name: "sine.wav",
    mimeType: "audio/wav",
    buffer: wavBytes(),
  });

  // The import selects what it imported: picking a file and then having to
  // pick it again from a menu is one step too many.
  await expect(slot.locator("option")).toHaveText(["No sample", "sine.wav"]);
  await expect(slot).not.toHaveValue("");
  await expect(page.getByTestId("toolbar-status-message")).toHaveText(/Imported sine\.wav/);
});

test("the sample survives a reload — bytes in storage, reference in the project", async ({
  page,
}) => {
  const deviceId = await bootAndSelectSampler(page);
  await page.getByTestId(`sample-file-${deviceId}`).setInputFiles({
    name: "kept.wav",
    mimeType: "audio/wav",
    buffer: wavBytes(),
  });
  await expect(page.getByTestId(`sample-select-${deviceId}`).locator("option")).toHaveText([
    "No sample",
    "kept.wav",
  ]);

  // Autosave is debounced ~2 s (SS13); wait for the document to land before
  // pulling the page out from under it.
  await expect(page.getByTestId("autosave-status")).toHaveText("Saved", { timeout: 10_000 });

  await page.reload();
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();

  const slot = page.getByTestId(`sample-select-${deviceId}`);
  await expect(slot.locator("option")).toHaveText(["No sample", "kept.wav"]);
  await expect(slot).not.toHaveValue("");
});

test("a file that is not audio is refused, and leaves nothing behind", async ({ page }) => {
  const deviceId = await bootAndSelectSampler(page);
  await page.getByTestId(`sample-file-${deviceId}`).setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("this is not a wav"),
  });

  await expect(page.getByTestId("toolbar-status-message")).toHaveText(/notes\.txt is not audio/);
  // No half-imported asset in the picker.
  await expect(page.getByTestId(`sample-select-${deviceId}`).locator("option")).toHaveText([
    "No sample",
  ]);
});
