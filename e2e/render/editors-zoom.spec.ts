import { expect, test } from "@playwright/test";
import { bootAudio, collectPageErrors, countMatchingPixels, longestVerticalRun } from "./helpers";

// M1 render probe check 1: "Arrangement view and piano roll both render;
// screenshot each at two zoom levels" (SS9's canvas editor kit; SS10's piano
// roll). Both editors mount simultaneously in M1's split layout (App.tsx).
//
// The arrangement view has REAL content out of the box: the starter project
// (src/demo/project.ts) is one track with the M0 demo phrase already drawn
// into its clip, so "renders" is verified against an actual clip rectangle
// with note-preview glyphs inside it, not a blank grid.
//
// The piano roll's note content is NOT reachable through the real UI in this
// build: SS10 says double-click opens a clip (arrangement.ts) / creates a
// note (dragMarquee.ts), but `src/editor/kit/points.ts`'s `pointerInputOf`
// derives click count from `PointerEvent.detail`, which real browsers report
// as 0 on every `pointerdown`/`pointerup` (click-count semantics live only on
// `MouseEvent` `click`/`dblclick`, never on `PointerEvent`). See
// `e2e/render/piano-roll-open.spec.ts`, which proves this with a native
// event-listener probe and reports it as a blocker finding. Consequently this
// spec can only assert the piano roll's STRUCTURAL render (grid, rows,
// ruler) — never real note content — which is itself part of what the probe
// must report honestly rather than paper over.

const HEADER_WIDTH_PX = 132; // src/editor/arrangement/constants.ts
const RULER_HEIGHT_PX = 26; // ditto
const LANE_HEIGHT_PX = 56; // ditto, DEFAULT_LANE_HEIGHT_PX
const CLIP_FILL = { r: 79, g: 123, b: 214 }; // DEFAULT_THEME.clipFill #4f7bd6
const ROW_WHITE = { r: 30, g: 33, b: 40 }; // DEFAULT_PIANO_ROLL_THEME.rowWhite #1e2128

test.describe("arrangement view", () => {
  test("renders the starter clip with real content, at two zoom levels", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto("/");
    await bootAudio(page);

    const arrangement = page.getByTestId("arrangement-panel");
    await expect(arrangement).toBeVisible();
    // The starter clip's name label ("Track 1") is drawn as canvas text, not
    // DOM — so "real content" is asserted on pixels below, not accessibility
    // tree text. This assertion is just "the lane header exists".
    await expect(page.getByText("Track 1")).toBeVisible();

    // A check that "passes" against a blank canvas is a fail (per the probe
    // brief): assert the clip's fill color is actually present in the
    // content layer before screenshotting anything.
    const clipPixelsBefore = await countMatchingPixels(page, "arrangement-panel", "fbl-layer-content", CLIP_FILL, 12);
    expect(clipPixelsBefore, "clip fill pixels drawn before zoom").toBeGreaterThan(500);

    await page.screenshot({
      path: ".playwright/screenshots/M1/render/arrangement-zoom-1-default.png",
      fullPage: true,
    });

    // Zoom in (Ctrl/Cmd+wheel = zoom-to-cursor, SS9) centered on the clip so
    // the clip visibly grows rather than scrolling off-canvas.
    const box = await arrangement.boundingBox();
    if (box === null) throw new Error("arrangement panel has no box");
    const cx = box.x + HEADER_WIDTH_PX + 40;
    const cy = box.y + RULER_HEIGHT_PX + LANE_HEIGHT_PX / 2;
    await page.mouse.move(cx, cy);
    await page.keyboard.down("Control");
    // Six large notches zoom in noticeably (ZOOM_WHEEL_SENSITIVITY makes any
    // single notch a subtle change; stack several so the two screenshots are
    // unambiguously different zoom levels, not noise).
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -240);
    }
    await page.keyboard.up("Control");
    await page.waitForTimeout(150);

    const clipPixelsAfter = await countMatchingPixels(page, "arrangement-panel", "fbl-layer-content", CLIP_FILL, 12);
    // Zooming in must widen the clip's on-screen footprint (more device
    // pixels of clip fill) — this is the actual proof "two zoom levels" were
    // exercised, not just two screenshots taken at the same zoom.
    expect(clipPixelsAfter, "clip fill pixels after zooming in").toBeGreaterThan(clipPixelsBefore * 1.5);

    await page.screenshot({
      path: ".playwright/screenshots/M1/render/arrangement-zoom-2-zoomed-in.png",
      fullPage: true,
    });

    expect(errors.consoleErrors, "console errors").toEqual([]);
    expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
    expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
  });
});

test.describe("piano roll", () => {
  test("renders its grid structure at two zoom levels", async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto("/");
    await bootAudio(page);

    const pianoRoll = page.getByTestId("piano-roll-panel");
    await expect(pianoRoll).toBeVisible();

    // Real structural content: the row-banding fill (white/black key rows)
    // must actually be painted, not just an empty background rect.
    const rowPixelsBefore = await countMatchingPixels(page, "piano-roll-panel", "fbl-layer-grid", ROW_WHITE, 10, 4);
    expect(rowPixelsBefore, "row-band pixels drawn before zoom").toBeGreaterThan(50);
    const runBefore = await longestVerticalRun(page, "piano-roll-panel", "fbl-layer-grid", 20);

    await page.screenshot({
      path: ".playwright/screenshots/M1/render/piano-roll-zoom-1-default.png",
      fullPage: true,
    });

    const box = await pianoRoll.boundingBox();
    if (box === null) throw new Error("piano roll has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -240); // zoom in horizontally (pxPerTick)
    }
    await page.keyboard.up("Control");
    // Vertical zoom too (Shift+Ctrl+wheel = zoomRowsAt, SS9).
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -240);
    }
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await page.waitForTimeout(150);

    await page.screenshot({
      path: ".playwright/screenshots/M1/render/piano-roll-zoom-2-zoomed-in.png",
      fullPage: true,
    });

    // The row band height must have grown with the vertical zoom — proof the
    // second screenshot is a genuinely different zoom level, structurally.
    const runAfter = await longestVerticalRun(page, "piano-roll-panel", "fbl-layer-grid", 20);
    expect(runAfter, "row band run length after vertical zoom-in").toBeGreaterThan(runBefore * 1.3);

    expect(errors.consoleErrors, "console errors").toEqual([]);
    expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
    expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
  });
});
