import { expect, test } from "@playwright/test";
import { ARR_CLIP_FILL, NOTE_FILL, collectPageErrors, scanColorRects, scanNotes, type ColorRect } from "./editing-helpers";

// SS13 autosave / SS2 "open -> edit -> save -> reopen" stability, against the
// REAL OPFS backend (src/app/persistence.ts `createAppProjectStorage`; the
// app is never handed the in-memory test double here). Each Playwright test
// gets a fresh, isolated browser context/profile, so OPFS starts empty and
// `loadOrCreateProject` falls back to the starter demo project on first
// load — that fallback, and the fact that an edit made after it survives a
// full page reload, is exactly what this spec proves.
test("an edit is restored unchanged after Save + full page reload (OPFS)", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto("/");

  const clips = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 20,
  });
  expect(clips.length, "expected the starter project's demo clip to render").toBeGreaterThan(0);
  const clip = clips[0] as ColorRect;
  await page.mouse.dblclick(clip.pageCenterX, clip.pageCenterY);
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();

  // Add a note in an isolated spot (low pitch, far right) so it cannot be
  // confused with the starter phrase's own notes.
  const panelBox = (await page.getByTestId("piano-roll-panel").boundingBox())!;
  const clickPoint = { x: panelBox.x + panelBox.width * 0.85, y: panelBox.y + panelBox.height - 100 };
  const beforeCreate = await scanNotes(page, NOTE_FILL);
  await page.mouse.dblclick(clickPoint.x, clickPoint.y);
  const afterCreate = await scanNotes(page, NOTE_FILL);
  expect(afterCreate.length, "the new note should have been added").toBe(beforeCreate.length + 1);
  const projectName = await page.getByTestId("project-name-input").inputValue();

  // Force-flush the debounced autosave (SS13: "~2s debounce") deterministically.
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("autosave-status")).toHaveText("Saved", { timeout: 10_000 });

  await page.reload();
  await expect(page.getByTestId("project-name-input")).toHaveValue(projectName ?? "");

  const clipsAfterReload = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 20,
  });
  expect(clipsAfterReload.length).toBeGreaterThan(0);
  await page.mouse.dblclick(
    (clipsAfterReload[0] as ColorRect).pageCenterX,
    (clipsAfterReload[0] as ColorRect).pageCenterY,
  );
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();

  const afterReload = await scanNotes(page, NOTE_FILL);
  expect(afterReload.length, "the note count after reload must equal the count right before it").toBe(
    afterCreate.length,
  );

  // The specific note we added must reappear in the same place, not just
  // "some note somewhere" (a note count match alone would also pass a
  // reload that silently reset to the DEFAULT phrase plus one arbitrary
  // note — position match rules that out).
  const stillThere = afterReload.some(
    (r) => Math.abs(r.x - (afterCreate.find((a) => !beforeCreate.some((b) => Math.abs(b.x - a.x) < 2 && Math.abs(b.y - a.y) < 2))?.x ?? -9999)) < 3,
  );
  expect(stillThere, "the specific note added before reload must reappear at the same position").toBe(true);

  expect(errors.consoleErrors, "console errors across open->edit->save->reload").toEqual([]);
  expect(errors.pageErrors, "uncaught exceptions across open->edit->save->reload").toEqual([]);
  expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
  await page.screenshot({ path: ".playwright/screenshots/M1/interaction/persistence-after-reload.png" });
});

// SS13's "~2 s debounce" itself, against the REAL OPFS backend. The spec
// above force-flushes through the Save button, so without this one the
// unforced timer path is only ever covered by unit tests over the in-memory
// double: a regression that stopped `scheduleIfNeeded` from ever firing while
// leaving `flush()` working would pass the whole suite.
test("an unforced edit autosaves after the debounce (no Save click)", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto("/");

  const clips = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 20,
  });
  expect(clips.length, "expected the starter project's demo clip to render").toBeGreaterThan(0);
  const clip = clips[0] as ColorRect;
  await page.mouse.dblclick(clip.pageCenterX, clip.pageCenterY);
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();

  const panelBox = (await page.getByTestId("piano-roll-panel").boundingBox())!;
  const beforeCreate = await scanNotes(page, NOTE_FILL);
  await page.mouse.dblclick(panelBox.x + panelBox.width * 0.7, panelBox.y + panelBox.height - 120);
  const afterCreate = await scanNotes(page, NOTE_FILL);
  expect(afterCreate.length).toBe(beforeCreate.length + 1);

  // The write lands on its own, with nothing but time passing — no Save
  // click anywhere in this test.
  await expect(page.getByTestId("autosave-status")).toHaveText("Saved", { timeout: 15_000 });

  await page.reload();
  const clipsAfterReload = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 20,
  });
  await page.mouse.dblclick(
    (clipsAfterReload[0] as ColorRect).pageCenterX,
    (clipsAfterReload[0] as ColorRect).pageCenterY,
  );
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();
  const afterReload = await scanNotes(page, NOTE_FILL);
  expect(afterReload.length, "the debounced write must have carried the new note").toBe(
    afterCreate.length,
  );

  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});
