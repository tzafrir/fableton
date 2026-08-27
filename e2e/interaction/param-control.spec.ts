import { expect, test } from "@playwright/test";

// SS3's param fast path A, in the shipped app and a real browser: the filter
// cutoff slider is M0's only live write into the engine. Dragging it must
// reach the real `BiquadFilterNode` through the `ParamHandle` (never a raw
// node reference — SS4's design rule), and releasing the gesture must commit
// exactly one value: "one gesture = one command = one undo entry".
//
// The headless half of this seam is covered in src/app/App.test.tsx; this is
// the proof that the same wiring holds against a real AudioContext.
test("the cutoff slider writes through the handle and commits once on release", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded/, {
    timeout: 10_000,
  });

  const slider = page.getByTestId("filter-cutoff");
  const readout = page.getByTestId("filter-cutoff-value");
  const before = await readout.textContent();
  expect(before).toMatch(/Hz|kHz/);

  // Watch the commit stream (the seam M1's command bus attaches to).
  await page.evaluate(() => {
    const engine = window.__fabletonDemo?.engine;
    if (!engine) throw new Error("engine bridge missing — boot did not finish");
    const seen: number[] = [];
    (window as unknown as { __commits: number[] }).__commits = seen;
    engine.onParamCommit((commit) => seen.push(commit.value));
  });

  await slider.fill("0.2");
  await expect(readout).not.toHaveText(before ?? "");

  const live = await page.evaluate(() => {
    const engine = window.__fabletonDemo?.engine;
    if (!engine) throw new Error("engine bridge missing");
    const handle = engine.params.require("chan:demo-track/dev:demo-filter/cutoff");
    return { live: handle.live(), base: handle.base(), text: handle.desc.toText(handle.live()) };
  });
  expect(await readout.textContent()).toBe(live.text);

  // `fill` dispatches input without a pointer gesture, so nothing is committed
  // yet: the drag reached the DSP, the document is untouched.
  expect(await page.evaluate(() => (window as unknown as { __commits: number[] }).__commits)).toEqual(
    [],
  );
  expect(live.base).not.toBe(live.live);

  // Gesture end.
  await slider.dispatchEvent("pointerup");
  const commits = await page.evaluate(
    () => (window as unknown as { __commits: number[] }).__commits,
  );
  expect(commits).toEqual([live.live]);
});
