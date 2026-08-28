// The MIDI effect chain (SS7 `midiEffect`), through the UI it is reached by.
//
// The arpeggiator's own pattern math is unit-tested headlessly, and the
// engine test proves a chord becomes a stream on its way to the instrument.
// What needs a browser is the rest: that the chain is its own section of the
// device panel, that it survives a save and reload, and — the one that no
// headless test can make — that a chord held with the transport STOPPED
// keeps sounding, which only happens if the shell's free-running pump is
// really turning.

import { expect, test, type Page } from "@playwright/test";

async function selectTrack(page: Page): Promise<string> {
  await page.getByTestId("tab-mixer").click();
  const strip = page.locator('[data-testid^="strip-"][data-role="track"]').first();
  const trackId = ((await strip.getAttribute("data-testid")) ?? "").replace("strip-", "");
  await strip.click();
  return trackId;
}

/** Control testids carry the FULL param path — the control kit's own
 *  convention, shared by every device panel. */
function ctl(trackId: string, deviceId: string, localId: string): string {
  return `ctl-chan:${trackId}/dev:${deviceId}/${localId}`;
}

async function addArp(page: Page): Promise<{ trackId: string; deviceId: string }> {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  // Params are registered by the ENGINE, which does not exist until audio is
  // booted — an unbooted panel draws placeholders, not controls (SS5).
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  const trackId = await selectTrack(page);
  await page.getByTestId("add-note-effect-select").selectOption({ label: "Arpeggiator" });
  const card = page.getByTestId("note-chain").locator(".fbl-device");
  await expect(card).toHaveCount(1);
  return { trackId, deviceId: ((await card.getAttribute("data-testid")) ?? "").replace("device-", "") };
}

test("a note effect goes into its own chain, not into the audio one", async ({ page }) => {
  const { trackId, deviceId } = await addArp(page);

  // It is inside the MIDI rail...
  await expect(page.getByTestId("note-chain").getByTestId(`device-${deviceId}`)).toBeVisible();
  // ...and it did NOT land in the channel's audio chain.
  const inAudioChain = await page.evaluate(() => {
    const doc = window.__fabletonDemo!.store!.getState();
    const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
    return {
      chain: doc.channels[track]!.chain.length,
      midiChain: doc.channels[track]!.midiChain?.length ?? 0,
    };
  });
  expect(inAudioChain).toEqual({ chain: 0, midiChain: 1 });

  // Its params are ordinary params, with ordinary controls.
  await expect(page.getByTestId(ctl(trackId, deviceId, "rate"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "mode"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "hold"))).toBeVisible();
});

test("the audio-effect picker does not offer it, and vice versa", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await selectTrack(page);

  const audioOptions = await page.getByTestId("add-effect-select").locator("option").allInnerTexts();
  expect(audioOptions).toContain("EQ Eight");
  expect(audioOptions).not.toContain("Arpeggiator");

  const noteOptions = await page
    .getByTestId("add-note-effect-select")
    .locator("option")
    .allInnerTexts();
  expect(noteOptions).toContain("Arpeggiator");
  expect(noteOptions).not.toContain("EQ Eight");
});

test("it survives a save and reload, in the same chain", async ({ page }) => {
  const { trackId, deviceId } = await addArp(page);
  await page.getByTestId(ctl(trackId, deviceId, "mode")).selectOption({ label: "Up/Down" });

  // Force-flush the debounced autosave (SS13: "~2s debounce").
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("autosave-status")).toHaveText("Saved", { timeout: 10_000 });

  await page.reload();
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await selectTrack(page);
  await expect(page.getByTestId("note-chain").getByTestId(`device-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "mode"))).toHaveValue("2");
});

test("removing it leaves the track playable", async ({ page }) => {
  const { deviceId } = await addArp(page);
  await page.getByTestId(`device-remove-${deviceId}`).click();
  await expect(page.getByTestId("note-chain").locator(".fbl-device")).toHaveCount(0);
  const state = await page.evaluate(() => {
    const doc = window.__fabletonDemo!.store!.getState();
    const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
    return {
      midiChain: doc.channels[track]!.midiChain ?? null,
      hasInstrument: doc.channels[track]!.source !== null,
    };
  });
  // Absent, not empty — the two mean the same thing and only one of them
  // encodes to nothing.
  expect(state).toEqual({ midiChain: null, hasInstrument: true });
});

// The one claim only a browser can settle: with the transport STOPPED there
// is no look-ahead window, so an arpeggiator that answers a held chord is
// proof that the shell's free-running rAF pump is turning.
test("a chord held with the transport stopped keeps arpeggiating", async ({ page }) => {
  await addArp(page);

  const masterId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="master"]')
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  const meter = page.locator(`[data-testid="meter-${masterId}"] > div`).first();
  const level = async (): Promise<number> => {
    const h = await meter.evaluate((el) => (el as HTMLElement).style.height);
    return Number.parseFloat(h === "" ? "0" : h);
  };

  // Nothing is playing, so any level at all has to come from the keys.
  expect(await level()).toBe(0);

  // Hold a chord on the computer keyboard (a / d / g are C, E, G) and never
  // let go. Without the free-run pump the arpeggiator swallows it: the notes
  // reach the arp, and the arp has no clock to hand them on with.
  await page.keyboard.down("a");
  await page.keyboard.down("d");
  await page.keyboard.down("g");

  await expect
    .poll(level, {
      timeout: 8_000,
      message: "a held chord must keep sounding with the transport stopped",
    })
    .toBeGreaterThan(0);

  await page.keyboard.up("a");
  await page.keyboard.up("d");
  await page.keyboard.up("g");
});
