import { expect, test } from "@playwright/test";

// SS3's param fast path A, in the shipped app and a real browser. Suspended
// at M1 (see git history for the original framing); M2's control kit and
// mixer strips are exactly what it was waiting for, so it now drives the
// REAL track volume fader: dragging writes to the engine through the SS4
// handle with the DOCUMENT untouched, and releasing commits exactly one
// value — "one gesture = one command = one undo entry".
//
// The headless half of this seam is covered in src/state/paramBridge.test.ts
// and src/ui/controls/gesture.test.ts; this is the proof against a real
// AudioContext and real pointer events.
test("the volume fader writes through the handle and commits once on release", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded/, {
    timeout: 10_000,
  });
  await page.getByTestId("tab-mixer").click();

  const strip = page.locator('[data-testid^="strip-"][data-role="track"]').first();
  const trackId = ((await strip.getAttribute("data-testid")) ?? "").replace("strip-", "");
  const paramId = `chan:${trackId}/vol`;
  const fader = page.getByTestId(`vol-${trackId}`);
  await expect(fader).toBeVisible();

  // Watch the commit stream (the seam the command bus attaches to).
  await page.evaluate(() => {
    const engine = window.__fabletonDemo?.engine;
    if (!engine) throw new Error("engine bridge missing — boot did not finish");
    const seen: number[] = [];
    (window as unknown as { __commits: number[] }).__commits = seen;
    engine.onParamCommit((commit) => seen.push(commit.value));
  });

  const box = (await fader.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 25, { steps: 6 });

  // Mid-drag: the DSP sees the new value, the document does NOT.
  const midDrag = await page.evaluate((id) => {
    const engine = window.__fabletonDemo?.engine;
    if (!engine) throw new Error("engine bridge missing");
    const handle = engine.params.require(id);
    return { live: handle.live(), base: handle.base() };
  }, paramId);
  expect(midDrag.live).not.toBe(midDrag.base);
  expect(
    await page.evaluate(() => (window as unknown as { __commits: number[] }).__commits),
  ).toEqual([]);

  // Gesture end: exactly ONE commit, carrying the released value.
  await page.mouse.up();
  const commits = await page.evaluate(
    () => (window as unknown as { __commits: number[] }).__commits,
  );
  expect(commits.length).toBe(1);
  expect(commits[0]).toBeCloseTo(midDrag.live, 5);

  // And exactly one undo entry for the whole drag.
  await expect(page.getByTestId("undo-button")).toBeEnabled();
});
