import { expect, test, type Page } from "@playwright/test";
import {
  ARR_CLIP_FILL,
  GHOST_FILL,
  NOTE_FILL,
  NOTE_SELECTED_FILL,
  collectPageErrors,
  dragEnd,
  dragStart,
  dragTo,
  scanColorRects,
  scanNotes,
  type ColorRect,
} from "./editing-helpers";

// M1 "interaction" probe: SS9/SS10's piano-roll gesture FSM, driven with
// real pointer/keyboard events against a production build and read back off
// the real rendered canvas (see editing-helpers.ts for why pixels, not a
// state hook, is the read path a verifier is allowed to use).
//
// Every test starts from "New" (src/state/project.ts `createEmptyProject`):
// one bar, one track, one EMPTY clip. That keeps every scanned note rect
// unambiguous — this suite's own notes are the only blue pixels on the
// content layer — instead of colliding with the starter project's packed
// demo phrase (src/demo/clip.ts).

async function openEmptyClip(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();
  const clips = await scanColorRects(page, "arrangement-panel", "content", ARR_CLIP_FILL, {
    minAreaDevicePx: 40,
  });
  expect(clips.length, "expected the fresh project's one empty clip to render").toBeGreaterThan(0);
  const clip = clips[0] as ColorRect;
  await page.mouse.dblclick(clip.pageCenterX, clip.pageCenterY);
  await expect(page.getByTestId("piano-roll-panel")).toBeVisible();
}

/** Double-click empty grid at an isolated (px,py) inside the piano roll's
 *  note area (SS10 `Pending`: "dbl-click empty: create grid-length note").
 *  Using one pitch/x per test keeps every created note far from any other
 *  test's, and far from the note-area's own edges. */
async function createNoteAt(page: Page, px: number, py: number): Promise<ColorRect> {
  const before = await scanNotes(page, NOTE_FILL);
  await page.mouse.dblclick(px, py);
  const after = await scanNotes(page, NOTE_FILL);
  expect(after.length, "double-click on empty grid should create exactly one new note").toBe(
    before.length + 1,
  );
  const created = after.find(
    (r) => !before.some((b) => Math.abs(b.x - r.x) < 2 && Math.abs(b.y - r.y) < 2),
  );
  expect(created, "could not find the newly-created note's rect").toBeTruthy();
  return created as ColorRect;
}

/** A point safely inside the piano roll's note area (below the ruler, above
 *  the velocity lane — RULER_HEIGHT_PX/VELOCITY_LANE_HEIGHT_PX,
 *  src/editor/pianoroll/layout.ts), independent of viewport scroll. */
const RULER_HEIGHT_PX = 20;
const VELOCITY_LANE_HEIGHT_PX = 72;
function gridPoint(panelBox: { x: number; y: number; width: number; height: number }, xFrac: number, yFrac: number) {
  const top = RULER_HEIGHT_PX + 6;
  const bottom = Math.max(top + 20, panelBox.height - VELOCITY_LANE_HEIGHT_PX - 6);
  return {
    x: panelBox.x + panelBox.width * xFrac,
    y: panelBox.y + top + (bottom - top) * yFrac,
  };
}

test.describe("piano roll note editing (SS9/SS10)", () => {
  test("draw a note, drag its body, and it moves by the snapped delta", async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    expect(panelBox).toBeTruthy();
    const p = gridPoint(panelBox!, 0.2, 0.3);

    const note = await createNoteAt(page, p.x, p.y);
    const startX = note.pageCenterX;
    const startY = note.pageCenterY;

    // Drag the body by an UN-snapped amount (37px) horizontally; the default
    // grid at the default zoom is 240 ticks = 12 CSS px (adaptive ladder
    // picks 1/16 @ 0.05 px/tick, see src/editor/kit/grid.ts), so a real
    // snap must land the note on a multiple of 12px, not on 37.
    await dragStart(page, { x: startX, y: startY });
    await dragTo(page, { x: startX + 37, y: startY });
    await dragTo(page, { x: startX + 37, y: startY });
    await dragEnd(page);

    const after = await scanNotes(page, NOTE_FILL);
    expect(after.length, "drag must not create or delete notes").toBe(1);
    const moved = after[0] as ColorRect;
    const deltaX = moved.x - note.x;
    expect(deltaX, "note should actually have moved").toBeGreaterThan(5);
    // Snapped to a whole number of 12px grid cells (tolerant of the
    // renderer's half/whole-pixel alignment, SS9 `alignPixel`).
    const cells = deltaX / 12;
    expect(Math.abs(cells - Math.round(cells)), `deltaX=${deltaX}px should be a multiple of 12px`).toBeLessThan(
      0.34,
    );
    expect(moved.y, "a horizontal-only drag must not change pitch").toBeCloseTo(note.y, 0);

    expect(errors.consoleErrors, "console errors").toEqual([]);
    expect(errors.pageErrors, "uncaught exceptions").toEqual([]);
    await page.screenshot({ path: ".playwright/screenshots/M1/interaction/drag-move.png" });
  });

  test("dragging a note's right edge resizes it with the LEFT edge anchored", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const p = gridPoint(panelBox!, 0.15, 0.35);
    const note = await createNoteAt(page, p.x, p.y);
    const leftBefore = note.x;
    const rightEdgeX = note.pageX + note.w - 2;

    await dragStart(page, { x: rightEdgeX, y: note.pageCenterY });
    await dragTo(page, { x: rightEdgeX + 48, y: note.pageCenterY });
    await dragEnd(page);

    const after = await scanNotes(page, NOTE_FILL);
    expect(after.length).toBe(1);
    const resized = after[0] as ColorRect;
    expect(resized.x, "left (anchored) edge must not move on a right-edge resize").toBeCloseTo(leftBefore, 0);
    expect(resized.w, "note should have widened").toBeGreaterThan(note.w + 20);
  });

  test("dragging a note's left edge resizes it with the RIGHT edge anchored", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const p = gridPoint(panelBox!, 0.35, 0.4);
    const note = await createNoteAt(page, p.x, p.y);
    const rightBefore = note.x + note.w;
    const leftEdgeX = note.pageX + 2;

    await dragStart(page, { x: leftEdgeX, y: note.pageCenterY });
    await dragTo(page, { x: leftEdgeX - 24, y: note.pageCenterY });
    await dragEnd(page);

    const after = await scanNotes(page, NOTE_FILL);
    expect(after.length).toBe(1);
    const resized = after[0] as ColorRect;
    expect(resized.x + resized.w, "right (anchored) edge must not move on a left-edge resize").toBeCloseTo(
      rightBefore,
      0,
    );
    expect(resized.x, "left edge should have moved left").toBeLessThan(note.x - 10);
  });

  test("Alt+drag on a note body duplicates it, leaving the original in place", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const p = gridPoint(panelBox!, 0.15, 0.5);
    const note = await createNoteAt(page, p.x, p.y);

    await dragStart(page, { x: note.pageCenterX, y: note.pageCenterY }, { mods: ["Alt"] });
    await dragTo(page, { x: note.pageCenterX + 60, y: note.pageCenterY });
    await dragTo(page, { x: note.pageCenterX + 60, y: note.pageCenterY });
    await dragEnd(page, { mods: ["Alt"] });

    const after = await scanNotes(page, NOTE_FILL);
    expect(after.length, "Alt+drag must leave the original AND create a copy").toBe(2);
    const originalStill = after.some((r) => Math.abs(r.x - note.x) < 2 && Math.abs(r.y - note.y) < 2);
    expect(originalStill, "the original note must still be at its start position").toBe(true);
    const copy = after.find((r) => Math.abs(r.x - note.x) >= 2);
    expect(copy, "expected a second note offset from the original").toBeTruthy();
  });

  test("marquee-drag on empty grid selects exactly the intersecting notes", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const box = panelBox!;

    // Three notes at three different pitches/times: A and B inside the
    // marquee, C well outside it both horizontally and vertically.
    const a = await createNoteAt(page, gridPoint(box, 0.15, 0.2).x, gridPoint(box, 0.15, 0.2).y);
    const b = await createNoteAt(page, gridPoint(box, 0.3, 0.35).x, gridPoint(box, 0.3, 0.35).y);
    const c = await createNoteAt(page, gridPoint(box, 0.7, 0.8).x, gridPoint(box, 0.7, 0.8).y);

    const marqueeFrom = { x: Math.min(a.pageX, b.pageX) - 8, y: Math.min(a.pageY, b.pageY) - 8 };
    const marqueeTo = {
      x: Math.max(a.pageX + a.w, b.pageX + b.w) + 8,
      y: Math.max(a.pageY + a.h, b.pageY + b.h) + 8,
    };
    // Sanity: the marquee must not also cover C.
    expect(marqueeTo.x).toBeLessThan(c.pageX - 10);

    await dragStart(page, marqueeFrom);
    await dragTo(page, marqueeTo);
    await dragEnd(page);

    // The velocity lane is excluded for the same reason `scanNotes` excludes
    // it: a SELECTED note's stalk is drawn in `velocityStalkSelected`, which
    // is the same amber as `noteSelectedFill`, so an unbounded scan counts
    // every selected note twice (body + stalk). Probe artifact, not an app
    // defect — see `scanColorRects`'s `excludeBottomCssPx` doc.
    const selected = await scanColorRects(page, "piano-roll-panel", "overlay", NOTE_SELECTED_FILL, {
      excludeBottomCssPx: VELOCITY_LANE_HEIGHT_PX,
    });
    expect(selected.length, "exactly A and B should be selected, not C").toBe(2);
    const coversA = selected.some((r) => Math.abs(r.x - a.x) < 3 && Math.abs(r.y - a.y) < 3);
    const coversB = selected.some((r) => Math.abs(r.x - b.x) < 3 && Math.abs(r.y - b.y) < 3);
    const coversC = selected.some((r) => Math.abs(r.x - c.x) < 3 && Math.abs(r.y - c.y) < 3);
    expect(coversA, "A should be selected").toBe(true);
    expect(coversB, "B should be selected").toBe(true);
    expect(coversC, "C must NOT be selected").toBe(false);
    await page.screenshot({ path: ".playwright/screenshots/M1/interaction/marquee-select.png" });
  });

  test("Esc mid-drag reverts the gesture and adds no undo entry", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const p = gridPoint(panelBox!, 0.2, 0.3);
    const note = await createNoteAt(page, p.x, p.y);

    // Creation itself is a command: undo should already be armed.
    await expect(page.getByTestId("undo-button")).toBeEnabled();
    const undoTitleAfterCreate = await page.getByTestId("undo-button").getAttribute("title");

    await dragStart(page, { x: note.pageCenterX, y: note.pageCenterY });
    await dragTo(page, { x: note.pageCenterX + 60, y: note.pageCenterY });
    // Confirm the drag actually promoted (a ghost exists) before cancelling —
    // otherwise "Esc reverted nothing" would trivially pass.
    const ghostsMidDrag = await scanColorRects(page, "piano-roll-panel", "overlay", GHOST_FILL);
    expect(ghostsMidDrag.length, "expected a drag ghost to be visible mid-gesture").toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await page.mouse.up();

    const after = await scanNotes(page, NOTE_FILL);
    expect(after.length).toBe(1);
    expect(after[0]!.x, "Esc must revert the note to its pre-drag position").toBeCloseTo(note.x, 0);

    // No new undo entry: the undo button's label is unchanged from right
    // after creation (still "undo the create", not "undo the move").
    const undoTitleAfterEscape = await page.getByTestId("undo-button").getAttribute("title");
    expect(undoTitleAfterEscape, "Esc-cancelled drag must add zero undo entries").toBe(undoTitleAfterCreate);
  });

  test("one gesture equals one undo entry: drag, undo restores exactly, redo reapplies", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const p = gridPoint(panelBox!, 0.2, 0.3);
    const note = await createNoteAt(page, p.x, p.y);

    await dragStart(page, { x: note.pageCenterX, y: note.pageCenterY });
    await dragTo(page, { x: note.pageCenterX + 48, y: note.pageCenterY });
    await dragEnd(page);

    const moved = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(moved.x, "sanity: the move actually happened").toBeGreaterThan(note.x + 5);

    // Undo the move (one entry) -> exactly the pre-move position.
    await page.getByTestId("undo-button").click();
    const afterUndo = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(afterUndo.x, "undo must restore the EXACT pre-drag x").toBeCloseTo(note.x, 0);
    expect(afterUndo.y).toBeCloseTo(note.y, 0);

    // Redo reapplies the same move.
    await expect(page.getByTestId("redo-button")).toBeEnabled();
    await page.getByTestId("redo-button").click();
    const afterRedo = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(afterRedo.x).toBeCloseTo(moved.x, 0);

    // Undo again: back to the CREATE-only state (one more undo empties the
    // grid entirely), proving the move really was a single, separate entry.
    await page.getByTestId("undo-button").click();
    await page.getByTestId("undo-button").click();
    const afterBothUndo = await scanNotes(page, NOTE_FILL);
    expect(afterBothUndo.length, "undoing move+create should empty the clip").toBe(0);
  });
});

test.describe("piano roll tool modes (SS10)", () => {
  // Regression guard for the second M1 finding: the shipped Toolbar had no
  // control for `ToolMode`, and App.tsx passed none, so `pencil` — and with
  // it SS10's `Paint` verb (drag on empty grid to create a note) — was
  // unreachable in the real app even though the editor implemented it.
  test("the toolbar's Pencil tool makes drag-to-create reachable in the app", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = (await page.getByTestId("piano-roll-panel").boundingBox())!;
    const start = gridPoint(panelBox, 0.25, 0.5);

    // In `select` mode (the default) the same drag is a MARQUEE, not a note.
    await expect(page.getByTestId("tool-select-button")).toHaveAttribute("aria-checked", "true");
    await dragStart(page, start);
    await dragTo(page, { x: start.x + 80, y: start.y + 4 });
    await dragEnd(page);
    expect(
      (await scanNotes(page, NOTE_FILL)).length,
      "a drag in select mode must marquee, never create a note",
    ).toBe(0);

    // Switch to pencil via the real toolbar control and repeat the drag.
    await page.getByTestId("tool-pencil-button").click();
    await expect(page.getByTestId("tool-pencil-button")).toHaveAttribute("aria-checked", "true");

    await dragStart(page, start);
    await dragTo(page, { x: start.x + 80, y: start.y + 4 });
    await dragEnd(page);

    const notes = await scanNotes(page, NOTE_FILL);
    expect(notes.length, "a drag in pencil mode must create exactly one note").toBe(1);
    expect(
      (notes[0] as ColorRect).w,
      "the painted note should be as long as the drag, not one grid cell",
    ).toBeGreaterThan(40);

    // And the tool switch is reversible from the same control.
    await page.getByTestId("tool-select-button").click();
    await expect(page.getByTestId("tool-select-button")).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("piano roll keyboard map (SS10)", () => {
  test("arrows transpose/move, Shift+arrows octave/fine, Ctrl+D duplicates, Delete deletes", async ({ page }) => {
    // This test measures a FULL OCTAVE jump (12 rows = 192px) by re-reading
    // the note's pixels, so the note area must be taller than 192px AND the
    // note must start low enough to have 208px (one row + one octave) of
    // headroom above it — otherwise it leaves the scanned region and the
    // assertion measures nothing. At the default 720px viewport the piano
    // roll gets ~222px total, only ~130px of it note area once the ruler and
    // velocity lane are taken out. Nothing in SS10/PLAN.md requires the
    // editor to auto-scroll a transposed note back into view, so the fix
    // here is the viewport and the note's starting row, not the app.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const p = gridPoint(panelBox!, 0.3, 0.9);
    const note = await createNoteAt(page, p.x, p.y);
    // A freshly-created note is auto-selected (src/editor/pianoroll/pianoRoll.ts).
    await page.getByTestId("piano-roll-panel").click({ position: { x: 2, y: 2 } });
    // Re-select it via a plain click (the panel click above may have cleared
    // selection by hitting empty grid) so the keymap has a target.
    await page.mouse.click(note.pageCenterX, note.pageCenterY);

    // ArrowUp: transpose +1 semitone -> row moves up by one row height (16px).
    await page.keyboard.press("ArrowUp");
    let r = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(note.y - r.y, "ArrowUp should raise pitch by exactly one row (16px)").toBeCloseTo(16, 0);
    const afterOneUp = r;

    // Shift+ArrowUp: +1 octave -> 12 more rows up (192px).
    await page.keyboard.press("Shift+ArrowUp");
    r = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(afterOneUp.y - r.y, "Shift+ArrowUp should jump a full octave (192px)").toBeCloseTo(192, 0);
    const afterOctave = r;

    // ArrowRight: move by current grid (12px at default zoom).
    await page.keyboard.press("ArrowRight");
    r = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(r.x - afterOctave.x, "ArrowRight should move by one grid cell (12px)").toBeCloseTo(12, 0);
    const afterRight = r;

    // Shift+ArrowRight: fine nudge, 1/64 note = 60 ticks = 3px — smaller than
    // a full grid step and in the same direction.
    await page.keyboard.press("Shift+ArrowRight");
    r = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    const fineDelta = r.x - afterRight.x;
    expect(fineDelta, "Shift+ArrowRight fine nudge should be smaller than a full grid step").toBeGreaterThan(0);
    expect(fineDelta, "fine nudge should be strictly less than the 12px grid step").toBeLessThan(12);

    // Ctrl+D: duplicate immediately after itself -> two notes now.
    await page.keyboard.press("Control+d");
    const afterDup = await scanNotes(page, NOTE_FILL);
    expect(afterDup.length, "Ctrl+D should duplicate the selected note").toBe(2);

    // Delete: the duplicate is auto-selected after Ctrl+D (SS10's
    // create-selects-result convention) — Delete removes only the selection.
    await page.keyboard.press("Delete");
    const afterDelete = await scanNotes(page, NOTE_FILL);
    expect(afterDelete.length, "Delete should remove exactly the selected (duplicated) note").toBe(1);
  });

  test("Ctrl+U quantizes note starts to the grid", async ({ page }) => {
    await openEmptyClip(page);
    const panelBox = await page.getByTestId("piano-roll-panel").boundingBox();
    const p = gridPoint(panelBox!, 0.3, 0.4);
    const note = await createNoteAt(page, p.x, p.y);
    await page.mouse.click(note.pageCenterX, note.pageCenterY);

    // ONE fine nudge: 60 ticks / 3px, a quarter of the 12px (240-tick) grid,
    // so it is unambiguously off-grid AND unambiguously nearer its original
    // slot than the next one. Two nudges would land on 120 ticks — exactly
    // half a grid cell, a rounding TIE that quantize legitimately resolves
    // upward, which measures the tie-break rule rather than quantization.
    await page.keyboard.press("Shift+ArrowRight");
    const offGrid = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(offGrid.x, "sanity: the note should have moved off its original grid slot").not.toBeCloseTo(note.x, 0);

    await page.keyboard.press("Control+u");
    const quantized = (await scanNotes(page, NOTE_FILL))[0] as ColorRect;
    expect(quantized.x, "Ctrl+U should quantize the start back onto the grid").toBeCloseTo(note.x, 0);
  });
});
