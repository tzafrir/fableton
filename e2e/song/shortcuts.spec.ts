import { expect, test, type Page } from "@playwright/test";
import { bootAudio } from "../render/helpers";

// The shell's key map, from the outside. Unit tests cover the matching
// (src/app/shortcuts.test.ts); what only a real browser can prove is that
// the keys reach the window at all — that Space is not swallowed by the
// button the user just clicked, that `?` opens the panel, and that a key an
// editor owns still goes to the editor.

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await bootAudio(page);
}

test("Space starts and stops the transport, right after clicking Boot audio", async ({ page }) => {
  await boot(page);
  // No click in between: the Boot button still holds focus, which is exactly
  // the case the `:focus-visible` rule exists for.
  await page.keyboard.press(" ");
  await expect(page.getByTestId("transport-state")).toHaveText("playing");
  await page.keyboard.press(" ");
  await expect(page.getByTestId("transport-state")).toHaveText("stopped");
});

test("Home returns the playhead to the start", async ({ page }) => {
  await boot(page);
  const arrangement = page.getByTestId("arrangement-panel");
  const box = await arrangement.boundingBox();
  if (box === null) throw new Error("no arrangement box");
  // Seek by clicking the ruler well to the right of zero (below the loop
  // band, which owns the ruler's top 10 px).
  await page.mouse.click(box.x + 132 + 300, box.y + 18);
  const playhead = arrangement.locator(".fbl-playhead").first();
  const moved = await playhead.evaluate((el) => (el as HTMLElement).style.transform);
  expect(moved).not.toBe("translateX(0px)");

  await page.keyboard.press("Home");
  await expect
    .poll(async () => playhead.evaluate((el) => (el as HTMLElement).style.transform))
    .toBe("translateX(0px)");
});

test("1 and 2 switch the piano-roll tool", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("2");
  await expect(page.getByTestId("tool-pencil-button")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("1");
  await expect(page.getByTestId("tool-select-button")).toHaveAttribute("aria-checked", "true");
});

test("? opens the keyboard reference, Escape closes it, and it says what the keys do", async ({
  page,
}) => {
  await boot(page);
  await page.keyboard.press("?");
  const overlay = page.getByTestId("shortcuts-overlay");
  await expect(overlay).toBeVisible();

  // The QWERTY diagram is generated from the mapping, so these are the real
  // note names for the default octave — `a` is C3, `;` is E4.
  const diagram = page.getByTestId("qwerty-diagram");
  await expect(diagram).toContainText("C3");
  await expect(diagram).toContainText("E4");
  await expect(overlay).toContainText("Play / Stop");
  await expect(overlay).toContainText("Quantize starts to the grid");

  await page.keyboard.press("Escape");
  await expect(overlay).not.toBeVisible();

  // And the toolbar button opens the same panel.
  await page.getByTestId("shortcuts-button").click();
  await expect(page.getByTestId("shortcuts-overlay")).toBeVisible();
  await page.getByTestId("shortcuts-close").click();
  await expect(page.getByTestId("shortcuts-overlay")).not.toBeVisible();
});

test("the diagram follows the octave, so it never lies about what a key plays", async ({ page }) => {
  await boot(page);
  await page.getByTestId("arrangement-panel").click({ position: { x: 300, y: 200 } });
  await page.keyboard.press("x"); // octave up
  await expect(page.getByTestId("keyboard-readout")).toContainText("Oct 4");
  await page.keyboard.press("?");
  await expect(page.getByTestId("qwerty-diagram")).toContainText("C4");
});

test("a key the piano roll owns still goes to the piano roll", async ({ page }) => {
  await boot(page);
  // Open the starter clip and select every note, then delete with the
  // editor's own binding. If the shell's window-level listener were stealing
  // keys, this would break.
  const arrangement = page.getByTestId("arrangement-panel");
  const box = await arrangement.boundingBox();
  if (box === null) throw new Error("no arrangement box");
  await page.mouse.dblclick(box.x + 132 + 20, box.y + 26 + 28);
  const roll = page.getByTestId("piano-roll-panel");
  await roll.click({ position: { x: 300, y: 120 } });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("undo-button")).toBeEnabled();
});
