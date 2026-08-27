import { expect, test } from "@playwright/test";
import { bootAudio, collectPageErrors } from "./helpers";

// M1 render probe check 3: "The playhead is a DOM element moved via
// transform (SS9): assert the element exists and its transform changes
// during playback while the content canvas is NOT redrawn every frame."
//
// SS9: "Playhead — a 1-px DOM element moved via `transform:
// translateX()`, so playback never forces canvas repaints." Implemented in
// `src/editor/kit/playhead.ts` (`createPlayheadView`, class `fbl-playhead`)
// and wired at rAF by `App.tsx`'s effect 6, which pushes the transport's
// position into BOTH editors every frame while playing — independent of
// whether a clip is open in the piano roll, so this check does not depend on
// the double-click-to-open-clip defect documented in
// `piano-roll-open.spec.ts`.
//
// The "canvas not redrawn" half is proven by instrumenting
// `CanvasRenderingContext2D.prototype.clearRect` (the one call every layer's
// `drawSlot` makes before it draws, see `renderer.ts`) via an init script
// installed BEFORE the app's module graph runs, tagged by which layer's
// canvas it belongs to.

async function installClearRectSpy(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const counts: Record<string, number> = {};
    (window as unknown as { __fblClearRectCounts: Record<string, number> }).__fblClearRectCounts = counts;
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.clearRect;
    proto.clearRect = function patchedClearRect(this: CanvasRenderingContext2D, ...args) {
      const canvas = this.canvas;
      const key = canvas.className || "(unnamed)";
      counts[key] = (counts[key] ?? 0) + 1;
      return original.apply(this, args);
    };
  });
}

async function readClearRectCounts(page: import("@playwright/test").Page): Promise<Record<string, number>> {
  return page.evaluate(
    () => (window as unknown as { __fblClearRectCounts: Record<string, number> }).__fblClearRectCounts,
  );
}

test("playhead is a DOM element that moves via transform without redrawing canvas layers", async ({ page }) => {
  const errors = collectPageErrors(page);
  await installClearRectSpy(page);
  await page.goto("/");
  await bootAudio(page);

  const arrangementPlayhead = page.locator('[data-testid="arrangement-panel"] .fbl-playhead');
  const pianoRollPlayhead = page.locator('[data-testid="piano-roll-panel"] .fbl-playhead');
  await expect(arrangementPlayhead, "arrangement playhead element exists").toHaveCount(1);
  await expect(pianoRollPlayhead, "piano roll playhead element exists").toHaveCount(1);

  // It really is a 1px absolutely-positioned DOM node moved by CSS
  // transform, not a canvas draw — assert the mechanism, not just presence.
  const tagAndStyle = await arrangementPlayhead.evaluate((el) => ({
    tag: el.tagName,
    position: getComputedStyle(el).position,
    hasTransform: el.style.transform.includes("translateX"),
  }));
  expect(tagAndStyle.tag).toBe("DIV");
  expect(tagAndStyle.position).toBe("absolute");
  expect(tagAndStyle.hasTransform).toBe(true);

  const transformBefore = await arrangementPlayhead.evaluate((el) => el.style.transform);

  // Let the initial mount's paint settle before taking the "quiet" baseline —
  // otherwise first-frame layer draws would count against the delta below.
  await page.waitForTimeout(200);
  const countsBefore = await readClearRectCounts(page);

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("transport-state")).toHaveText("playing");

  // Real playback time: several rAF frames' worth, so a redrawing bug would
  // show up as a large, unmistakable delta rather than a rounding fluke.
  await page.waitForTimeout(600);

  const transformAfter = await arrangementPlayhead.evaluate((el) => el.style.transform);
  const pianoRollTransformAfter = await pianoRollPlayhead.evaluate((el) => el.style.transform);
  const countsAfter = await readClearRectCounts(page);

  await page.getByRole("button", { name: "Stop", exact: true }).click();

  expect(transformAfter, "arrangement playhead transform changed during playback").not.toBe(transformBefore);
  expect(pianoRollTransformAfter, "piano roll playhead transform is set (non-empty) during playback").toMatch(
    /translateX/,
  );

  // The content/grid/overlay canvas layers must NOT have been redrawn by
  // playback alone (SS9's whole point). A handful of layer classes are
  // checked explicitly so a regression that adds a redraw to any one of them
  // is caught, not averaged away by summing counts.
  for (const layerClass of [
    "fbl-layer fbl-layer-grid",
    "fbl-layer fbl-layer-content",
    "fbl-layer fbl-layer-overlay",
  ]) {
    const before = countsBefore[layerClass] ?? 0;
    const after = countsAfter[layerClass] ?? 0;
    expect(after, `${layerClass} clearRect count unchanged across ~600ms of playback`).toBe(before);
  }

  expect(errors.consoleErrors, "console errors").toEqual([]);
  expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
  expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
});
