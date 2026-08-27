import { expect, test } from "@playwright/test";
import { bootAudio, collectPageErrors, pixelAt, readCanvasRegionPixels } from "./helpers";

// M1 render probe check 2: "Canvases are sized for devicePixelRatio: assert
// canvas.width === cssWidth * dpr (SS9) and that grid lines are not blurry."
//
// SS9: "All canvases render at `devicePixelRatio` with lines aligned to
// half-pixels for crispness." `src/editor/kit/renderer.ts`'s `applyCanvasSize`
// is the one place that multiplies by dpr: `Math.round(widthPx * dpr)`.
// `playwright.config.ts` runs this whole suite at `deviceScaleFactor: 2`.

const DPR = 2;

async function assertLayerCanvasesMatchDpr(page: import("@playwright/test").Page, testId: string): Promise<void> {
  const panel = page.getByTestId(testId);
  const sizes = await panel.evaluate((el) => {
    const canvases = Array.from(el.querySelectorAll("canvas"));
    return canvases.map((c) => ({
      className: c.className,
      width: c.width,
      height: c.height,
      cssWidth: c.getBoundingClientRect().width,
      cssHeight: c.getBoundingClientRect().height,
    }));
  });
  expect(sizes.length, `${testId} has at least one canvas layer`).toBeGreaterThan(0);
  for (const c of sizes) {
    expect(c.width, `${testId} ${c.className} canvas.width`).toBe(Math.round(c.cssWidth * DPR));
    expect(c.height, `${testId} ${c.className} canvas.height`).toBe(Math.round(c.cssHeight * DPR));
    // Sanity floor: a canvas sized 0 would trivially satisfy width===cssWidth*dpr
    // (0===0) without proving anything — SS15's "passing against a blank page
    // is a fail" applies to geometry assertions too.
    expect(c.width, `${testId} ${c.className} canvas.width is non-trivial`).toBeGreaterThan(50);
    expect(c.height, `${testId} ${c.className} canvas.height is non-trivial`).toBeGreaterThan(50);
  }
}

test("arrangement and piano-roll canvases are sized for devicePixelRatio 2", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto("/");
  await bootAudio(page);

  const reportedDpr = await page.evaluate(() => window.devicePixelRatio);
  expect(reportedDpr, "the harness's own deviceScaleFactor took effect").toBe(DPR);

  await assertLayerCanvasesMatchDpr(page, "arrangement-panel");
  await assertLayerCanvasesMatchDpr(page, "piano-roll-panel");

  expect(errors.consoleErrors, "console errors").toEqual([]);
  expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
  expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
});

// "Grid lines are not blurry": a hairline stroked at a half-pixel-aligned CSS
// coordinate (SS9's `alignHalfPixel`) and then scaled by an integer dpr must
// land on a small, sharp-edged run of device pixels — not a soft gradient
// spread across many columns, which is what you get from either scaling a
// low-res backing store up (wrong canvas.width) or drawing on a non-aligned
// coordinate (antialiasing straddles two columns instead of one).
//
// This scans real rendered pixels for the bar-2 line the arrangement grid
// draws at tick 3840 (PPQ 960 * 4/4 time signature = one bar) and asserts the
// line occupies a short contiguous run with a hard edge into the surrounding
// (uniform, non-track) lane fill on both sides.
test("arrangement bar line renders as a crisp hairline, not a blur", async ({ page }) => {
  await page.goto("/");
  await bootAudio(page);

  // HEADER_WIDTH_PX(132) + xOf(3840 ticks * 0.05 px/tick = 192 css px) =
  // 324 css px; RULER_HEIGHT_PX(26) + LANE_HEIGHT_PX(56, "Track 1") +
  // LANE_HEIGHT_PX/2 (56, "Master" row's own center) = 138 css px — a y
  // inside the empty "Master" lane, clear of any clip glyphs.
  const cssX = 132 + 3840 * 0.05;
  const cssY = 26 + 56 + 56 / 2;
  const deviceX = Math.round(cssX * 2);
  const deviceY = Math.round(cssY * 2);

  // A narrow horizontal strip (25px tall so a 1px vertical sampling error in
  // deviceY still lands inside it) around the expected line x, at device
  // resolution — bounded so this doesn't ship a multi-megapixel canvas over
  // the wire (see `readCanvasRegionPixels`'s doc comment).
  const regionX = deviceX - 20;
  const region = await readCanvasRegionPixels(page, "arrangement-panel", "fbl-layer-grid", {
    x: regionX,
    y: deviceY,
    width: 41,
    height: 1,
  });
  const localX = (dx: number): number => deviceX + dx - regionX;

  // The background/lane fill a few px away, on both sides, must be uniform —
  // establishes what "not the line" looks like.
  const bg = pixelAt(region, localX(-12), 0);
  const bgOther = pixelAt(region, localX(12), 0);
  expect(
    Math.abs(bg.r - bgOther.r) + Math.abs(bg.g - bgOther.g) + Math.abs(bg.b - bgOther.b),
    "lane background is uniform well away from the bar line",
  ).toBeLessThan(6);

  // Scan a window around the expected line position and find every column
  // that differs meaningfully from the background — that set must be small
  // (a crisp 1-2 device-px line at dpr 2) and contiguous, not a multi-pixel
  // antialiased smear.
  let runStart = -1;
  let runEnd = -1;
  for (let dx = -10; dx <= 10; dx += 1) {
    const p = pixelAt(region, localX(dx), 0);
    const delta = Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b);
    if (delta > 20) {
      if (runStart === -1) runStart = dx;
      runEnd = dx;
    } else if (runStart !== -1 && runEnd !== -1 && dx - runEnd > 1) {
      // A second, separate run after a gap would mean the line isn't a
      // single sharp edge — stop scanning, the run we found is the answer.
      break;
    }
  }

  expect(runStart, "a bar line was found near the expected tick-3840 position").toBeGreaterThan(-11);
  const runWidth = runEnd - runStart + 1;
  expect(runWidth, "bar line device-pixel width is crisp, not a multi-pixel blur").toBeLessThanOrEqual(3);
});
