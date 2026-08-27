import { expect, test } from "@playwright/test";
import { ARR_CLIP_FILL, NOTE_FILL, collectPageErrors, scanColorRects, scanNotes, type ColorRect } from "./editing-helpers";

// SS9 "zoom-to-cursor": Ctrl/Cmd+wheel on the piano roll must keep the tick
// under the cursor fixed on screen while pxPerTick changes
// (src/editor/kit/viewport.ts `zoomAt`). Measured, not eyeballed: the note's
// LEFT EDGE is placed exactly under the cursor before zooming, then the same
// edge's screen x is re-measured after zooming — it must not have moved,
// while the note's rendered width must have (proving a zoom really happened
// and this isn't a vacuous pass).
test("Ctrl+wheel zoom keeps the tick under the cursor fixed", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();

  const clips = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 40,
  });
  expect(clips.length).toBeGreaterThan(0);
  await page.mouse.dblclick((clips[0] as ColorRect).pageCenterX, (clips[0] as ColorRect).pageCenterY);
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();

  const panelBox = (await page.getByTestId("piano-roll-panel").boundingBox())!;
  const clickPoint = { x: panelBox.x + panelBox.width * 0.3, y: panelBox.y + 60 };
  await page.mouse.dblclick(clickPoint.x, clickPoint.y);

  const before = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
  expect(before, "expected the double-click to have created a note").toBeTruthy();

  // Put the cursor exactly on the note's left edge (a known, measured tick)
  // and zoom in around it.
  const cursorX = before.pageX + 1;
  const cursorY = before.pageCenterY;
  await page.mouse.move(cursorX, cursorY);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -400); // deltaY<0 => zoom in (see ZOOM_WHEEL_SENSITIVITY)
  await page.keyboard.up("Control");

  const after = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
  expect(after, "note should still exist after zoom").toBeTruthy();

  expect(after.w, "zoom must actually have changed scale (note should widen)").toBeGreaterThan(before.w * 1.5);
  // The left edge (which sat 1px right of the cursor) must stay within a
  // couple of CSS px of where it was — that IS zoomAt's contract.
  expect(Math.abs(after.x - before.x), "the tick under the cursor must stay fixed through the zoom").toBeLessThan(4);

  expect(errors.consoleErrors, "console errors").toEqual([]);
  expect(errors.pageErrors, "uncaught exceptions").toEqual([]);
  await page.screenshot({ path: ".playwright/screenshots/M1/interaction/zoom-at-cursor.png" });
});

test("Ctrl+wheel zoom-out also keeps the anchor tick fixed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();
  const clips = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 40,
  });
  await page.mouse.dblclick((clips[0] as ColorRect).pageCenterX, (clips[0] as ColorRect).pageCenterY);
  const panelBox = (await page.getByTestId("piano-roll-panel").boundingBox())!;
  const clickPoint = { x: panelBox.x + panelBox.width * 0.3, y: panelBox.y + 60 };
  await page.mouse.dblclick(clickPoint.x, clickPoint.y);
  // Zoom IN first. `zoomAt` holds the anchor by setting scroll to
  // `anchor - px/pxPerTick` (src/editor/kit/viewport.ts), and scroll is
  // clamped to `minTick: 0` — you cannot show ticks before the start of the
  // timeline. A fresh project sits at scroll 0, so zooming OUT there asks for
  // a negative scroll, the clamp wins, and the anchor MUST move. That clamp
  // is correct behavior (every DAW pins the timeline start), so this test
  // first zooms in to get scroll off 0, which is where the zoom-out anchor
  // contract is actually testable.
  const zoomInAt = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
  await page.mouse.move(zoomInAt.pageX + 1, zoomInAt.pageCenterY);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -600);
  await page.keyboard.up("Control");

  const before = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;

  const cursorX = before.pageX + 1;
  await page.mouse.move(cursorX, before.pageCenterY);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 400); // zoom out
  await page.keyboard.up("Control");

  const after = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
  expect(after.w, "zoom-out should shrink the note").toBeLessThan(before.w * 0.8);
  expect(Math.abs(after.x - before.x), "anchor tick must stay fixed on zoom-out too").toBeLessThan(4);
});
