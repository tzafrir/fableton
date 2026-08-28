// `core.eq8` — the curve, and whether it is the curve you HEAR.
//
// The response math is unit-tested headlessly (src/devices/core/eq8.test.ts),
// but "these are the Web Audio formulas" is not a claim jsdom can settle:
// nothing in it implements a biquad. So the load-bearing test here compares
// the drawn curve against a REAL `BiquadFilterNode.getFrequencyResponse` in
// a real browser, band type by band type. The rest is the panel: the canvas
// exists, and dragging it moves the document.

import { expect, test, type Page } from "@playwright/test";

/** Control testids carry the FULL param path (`ctl-chan:.../dev:.../b2freq`),
 *  which is the same convention the default panel uses. */
function ctl(trackId: string, deviceId: string, localId: string): string {
  return `ctl-chan:${trackId}/dev:${deviceId}/${localId}`;
}

async function addEq(page: Page): Promise<{ trackId: string; deviceId: string }> {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  // Params are registered by the ENGINE, which does not exist until audio is
  // booted — an unbooted panel draws placeholders, not controls (SS5).
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready/, { timeout: 10_000 });
  await page.getByTestId("tab-mixer").click();
  const trackId = (
    (await page
      .locator('[data-testid^="strip-"][data-role="track"]')
      .first()
      .getAttribute("data-testid")) ?? ""
  ).replace("strip-", "");
  await page.getByTestId(`strip-${trackId}`).click();
  await page.getByTestId("add-effect-select").selectOption({ label: "EQ Eight" });
  const card = page.locator('.fbl-device[data-editor="eq8"]');
  await expect(card).toBeVisible();
  return { trackId, deviceId: ((await card.getAttribute("data-testid")) ?? "").replace("device-", "") };
}

// The proof the whole editor rests on. A filter curve drawn from formulas
// that do not match the engine is worse than no curve at all: it is a picture
// that disagrees with the sound, and every EQ move made against it is wrong.
test("the drawn curve matches a real browser's biquad, for every band type", async ({ page }) => {
  await page.goto("/");

  const worst = await page.evaluate(async () => {
    const bridge = window.__fabletonDemo;
    if (!bridge) throw new Error("window.__fabletonDemo bridge missing — check src/main.tsx");
    const ctx = new OfflineAudioContext(1, 128, 48000);
    const node = ctx.createBiquadFilter();

    // One case per band type, each with a gain and a Q that actually bite.
    const cases = [
      { type: "lowcut", biquad: "highpass", freqHz: 400, gainDb: 0, q: 0.707 },
      { type: "lowcut", biquad: "highpass", freqHz: 900, gainDb: 0, q: 6 },
      { type: "lowshelf", biquad: "lowshelf", freqHz: 220, gainDb: 9, q: 1 },
      { type: "lowshelf", biquad: "lowshelf", freqHz: 500, gainDb: -12, q: 1 },
      { type: "bell", biquad: "peaking", freqHz: 1000, gainDb: 12, q: 3 },
      { type: "bell", biquad: "peaking", freqHz: 3000, gainDb: -8, q: 0.4 },
      { type: "notch", biquad: "notch", freqHz: 2000, gainDb: 0, q: 5 },
      { type: "highshelf", biquad: "highshelf", freqHz: 6000, gainDb: 10, q: 1 },
      { type: "highcut", biquad: "lowpass", freqHz: 5000, gainDb: 0, q: 0.707 },
      { type: "highcut", biquad: "lowpass", freqHz: 1200, gainDb: 0, q: 4 },
    ] as const;

    // Log-spaced probes across the audible range.
    const probes = new Float32Array(48);
    for (let i = 0; i < probes.length; i++) {
      probes[i] = 20 * (20000 / 20) ** (i / (probes.length - 1));
    }
    const mag = new Float32Array(probes.length);
    const phase = new Float32Array(probes.length);

    let worstDb = 0;
    let where = "";
    for (const c of cases) {
      node.type = c.biquad as BiquadFilterType;
      node.frequency.value = c.freqHz;
      node.gain.value = c.gainDb;
      // The app presents Q as a quality factor for every band type; Web Audio
      // reads it in DECIBELS on the two cut types, which is exactly the
      // conversion the device makes and this test has to make too.
      node.Q.value =
        c.biquad === "highpass" || c.biquad === "lowpass" ? 20 * Math.log10(c.q) : c.q;
      node.getFrequencyResponse(probes, mag, phase);

      for (let i = 0; i < probes.length; i++) {
        const engineDb = 20 * Math.log10(Math.max(mag[i]!, 1e-9));
        const drawnDb = bridge.bandResponseDb(
          { type: c.type, freqHz: c.freqHz, gainDb: c.gainDb, q: c.q, enabled: true },
          probes[i]!,
          ctx.sampleRate,
        );
        // Both floor out on a notch's null; only compare where it is audible.
        if (engineDb < -60 && drawnDb < -60) continue;
        const error = Math.abs(engineDb - drawnDb);
        if (error > worstDb) {
          worstDb = error;
          where = `${c.type} @ ${String(Math.round(probes[i]!))} Hz`;
        }
      }
    }
    return { worstDb, where };
  });

  // A tenth of a decibel is far below what an eye reads off a curve, and far
  // below what an ear hears — but it is well ABOVE float noise, so a genuine
  // formula slip (a sign, a missing sqrt(A), Q in the wrong units) cannot
  // hide under it.
  expect(worst.worstDb, `worst disagreement at ${worst.where}`).toBeLessThan(0.1);
});

test("adds an EQ Eight with its own editor instead of a knob grid", async ({ page }) => {
  const { deviceId } = await addEq(page);

  await expect(page.getByTestId(`eq8-canvas-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`eq8-band-${deviceId}-1`)).toBeVisible();
  await expect(page.getByTestId(`eq8-band-${deviceId}-8`)).toBeVisible();

  // The canvas is the panel: none of the 41 params is drawn as its own knob.
  const card = page.getByTestId(`device-${deviceId}`);
  await expect(card.locator(".fbl-param-row")).toHaveCount(0);
});

test("selecting a band shows its own controls, and only the ones it reads", async ({ page }) => {
  const { trackId, deviceId } = await addEq(page);

  // Band 2 is a bell: gain and Q both mean something.
  await page.getByTestId(`eq8-band-${deviceId}-2`).click();
  await expect(page.getByTestId(ctl(trackId, deviceId, "b2freq"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "b2gain"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "b2q"))).toBeVisible();

  // Band 1 is a low cut, which has no gain at all — Web Audio ignores it, so
  // a knob for it would be a number the user could move with no effect.
  await page.getByTestId(`eq8-band-${deviceId}-1`).click();
  await expect(page.getByTestId(ctl(trackId, deviceId, "b1freq"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "b1q"))).toBeVisible();
  await expect(page.getByTestId(ctl(trackId, deviceId, "b1gain"))).toHaveCount(0);
});

test("dragging a handle on the curve writes the band's frequency and gain", async ({ page }) => {
  const { deviceId } = await addEq(page);

  // Band 5 sits at 1.5 kHz, 0 dB by default: about 62% across a log axis from
  // 20 Hz to 20 kHz, on the centre line.
  await page.getByTestId(`eq8-band-${deviceId}-5`).click();

  const canvas = page.getByTestId(`eq8-canvas-${deviceId}`);
  // The device chain scrolls sideways, and selecting a band can scroll it —
  // so the box is measured LAST, or the drag lands on whatever is really at
  // those page coordinates.
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;

  // Grab the handle and haul it up and to the left.
  const startX = box.x + box.width * 0.625;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - box.width * 0.15, startY - box.height * 0.25, { steps: 8 });
  await page.mouse.up();

  const values = await page.evaluate(() => {
    const store = window.__fabletonDemo?.store;
    if (!store) throw new Error("no store on the bridge");
    const doc = store.getState();
    const track = doc.channelOrder.find((id) => doc.channels[id]?.role === "track")!;
    const deviceId2 = doc.channels[track]!.chain.find(
      (id) => doc.devices[id]?.definitionId === "core.eq8",
    )!;
    return {
      freq: doc.paramValues[`chan:${track}/dev:${deviceId2}/b5freq`],
      gain: doc.paramValues[`chan:${track}/dev:${deviceId2}/b5gain`],
    };
  });

  // Left is lower, up is louder — and the drag is COMMITTED, so it is in the
  // document rather than only on the screen.
  expect(values.freq).toBeLessThan(1500);
  expect(values.gain).toBeGreaterThan(2);
});

// The other half of "with visualization of the spectrum": the picture behind
// the curve has to be the SIGNAL, not decoration. Read back off the canvas,
// because a spectrum that draws nothing looks exactly like a quiet one.
test("the spectrum behind the curve shows what the EQ is putting out", async ({ page }) => {
  const { deviceId } = await addEq(page);
  const canvas = page.getByTestId(`eq8-canvas-${deviceId}`);
  await canvas.scrollIntoViewIfNeeded();

  /** Ink in the BOTTOM half of the canvas, where the curve is not: at rest
   *  that band holds only grid lines, so anything more is the spectrum. */
  const bottomInk = async (): Promise<number> =>
    canvas.evaluate((el) => {
      const c = (el as HTMLCanvasElement).getContext("2d");
      if (c === null) return 0;
      const h = (el as HTMLCanvasElement).height;
      const w = (el as HTMLCanvasElement).width;
      const data = c.getImageData(0, Math.floor(h * 0.55), w, Math.floor(h * 0.45)).data;
      let sum = 0;
      // The ground is #080a0e; count how far each pixel rises above it.
      for (let i = 0; i < data.length; i += 4) sum += Math.max(0, (data[i + 1] ?? 0) - 12);
      return sum;
    });

  const quiet = await bottomInk();
  await page.keyboard.down("a");
  await expect
    .poll(bottomInk, { timeout: 6_000, message: "a held note should paint the spectrum" })
    .toBeGreaterThan(quiet * 1.5 + 1000);
  await page.keyboard.up("a");
});

test("an EQ in the chain passes the signal rather than swallowing it", async ({ page }) => {
  // The response cross-check above proves the drawn curve IS the biquad's,
  // and the unit tests prove the device pushes those numbers into the nodes.
  // What is left is the wiring: eight biquads in series, in a real graph,
  // must be transparent when nobody has moved anything.
  await addEq(page);

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

  // Played from the keyboard rather than from the transport: a fresh
  // project's clip is EMPTY, so pressing Play would prove nothing about the
  // EQ and everything about the clip.
  expect(await level()).toBe(0);
  await page.keyboard.down("a");
  await expect
    .poll(level, { timeout: 5_000, message: "a flat EQ must pass the signal" })
    .toBeGreaterThan(0);
  await page.keyboard.up("a");
});
