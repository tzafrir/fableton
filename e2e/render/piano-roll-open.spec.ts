import { expect, test } from "@playwright/test";
import { bootAudio } from "./helpers";

// REGRESSION GUARD (was an M1 blocker, fixed 2026-08-27).
//
// SS10/SS18-M1: double-clicking a clip in the arrangement must open it in
// the piano roll (src/editor/arrangement/dragMove.ts: `if (info.clickCount
// >= 2) { ... context.openClip(...) }`), and double-clicking empty piano-roll
// grid must create a note (src/editor/pianoroll/dragMarquee.ts, same
// pattern).
//
// Both used to derive `clickCount` from `PointerEvent.detail`:
//
//   clickCount: event.detail === 0 ? 1 : event.detail,   // WRONG
//
// That is correct for `MouseEvent` `click`/`dblclick`, where `detail` really
// does carry the click count. It is NOT correct for `PointerEvent`
// `pointerdown`/`pointerup`: the Pointer Events spec fixes `detail` at 0 on
// every pointer event regardless of click count. The gesture engine listens
// for `pointerdown`/`pointerup` exclusively (`gestureEngine.ts`), so
// `clickCount` was always 1 in a real browser, `info.clickCount >= 2` could
// never be true, and double-click was unreachable in the shipped app. It
// passed tsc, all unit tests and the build, because the kit's unit tests
// hand-construct `PointerInput` objects with `clickCount: 2` directly and so
// are structurally blind to it.
//
// The fix is `createClickCounter` in src/editor/kit/points.ts: the DOM
// binding counts clicks itself from pointerdown timing/position, and nothing
// reads `detail` any more.
//
// The two tests below are the outside-in proof, via TWO independent signals:
//   1. the piano roll's content canvas draws the starter clip's note-fill
//      pixels (`theme.noteFill`, aqua) once the clip is open;
//   2. selecting all notes and nudging them (Cmd/Ctrl+A, ArrowRight)
//      dispatches a Move Notes command and enables Undo.
// The control test pins the ROOT CAUSE in place: it asserts that
// `pointerdown.detail` really is 0 on every call in a real browser (so nobody
// reintroduces the old expression) while the native `dblclick` DOM event
// does fire for the same input.

async function openStarterClipByDoubleClick(page: import("@playwright/test").Page): Promise<void> {
  const arrangement = page.getByTestId("arrangement-panel");
  const box = await arrangement.boundingBox();
  if (box === null) throw new Error("arrangement panel has no box");
  // HEADER_WIDTH_PX(132) + 20px into the clip body; RULER_HEIGHT_PX(26) +
  // half the first lane's height (28px) — the "Track 1" lane's clip body,
  // clear of edge/loop-brace hit zones (see editors-zoom.spec.ts).
  const x = box.x + 132 + 20;
  const y = box.y + 26 + 28;
  await page.mouse.dblclick(x, y);
}

async function contentLayerHasNoteFillPixels(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="piano-roll-panel"]');
    const canvas = panel?.querySelector<HTMLCanvasElement>(".fbl-layer-content");
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // noteFill is SIGNAL.aqua #35d0c8 = (53, 208, 200); tolerate the
    // velocity-opacity blend (SS10: "velocity reads as opacity") by checking
    // for the green+blue-dominant signature only that fill (or its stroke)
    // produces against the roll's blue-violet grid.
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const a = data[i + 3] ?? 0;
      if (a > 0 && g > 130 && b > 120 && r < 130) return true;
    }
    return false;
  });
}

test("control: pointerdown.detail is 0 in a real browser, even for a native double-click", async ({
  page,
}) => {
  // Must be an init script, not a post-navigation `page.evaluate`: the app
  // shell fully replaces `document` content on load, but more importantly a
  // plain `page.evaluate` before `goto` runs against `about:blank` and its
  // listeners are gone the moment navigation starts.
  await page.addInitScript(() => {
    (window as unknown as { __fblDbl: number }).__fblDbl = 0;
    (window as unknown as { __fblPointerDetails: number[] }).__fblPointerDetails = [];
    document.addEventListener("dblclick", () => {
      (window as unknown as { __fblDbl: number }).__fblDbl += 1;
    });
    document.addEventListener("pointerdown", (e) => {
      (window as unknown as { __fblPointerDetails: number[] }).__fblPointerDetails.push(
        (e as PointerEvent).detail,
      );
    });
  });
  await page.goto("/");
  await bootAudio(page);
  await openStarterClipByDoubleClick(page);
  await page.waitForTimeout(100);

  const info = await page.evaluate(() => ({
    dblclickCount: (window as unknown as { __fblDbl: number }).__fblDbl,
    pointerdownDetails: (window as unknown as { __fblPointerDetails: number[] }).__fblPointerDetails,
  }));

  expect(info.dblclickCount, "browser fired a native dblclick for this input").toBeGreaterThanOrEqual(1);
  expect(
    info.pointerdownDetails.every((d) => d === 0),
    `pointerdown.detail is 0 on every call in a real browser (got ${JSON.stringify(info.pointerdownDetails)}) — ` +
      "this is the root cause: gestureEngine.ts's clickCount can never reach 2",
  ).toBe(true);
});

test("double-clicking a clip opens it in the piano roll", async ({ page }) => {
  await page.goto("/");
  await bootAudio(page);

  await openStarterClipByDoubleClick(page);
  await page.waitForTimeout(300);

  const hasNotes = await contentLayerHasNoteFillPixels(page);
  expect(
    hasNotes,
    "piano roll content layer should show the starter clip's notes after double-clicking it open " +
      "(src/editor/arrangement/dragMove.ts + src/editor/kit/points.ts — see this file's header comment)",
  ).toBe(true);

  // Second, independent signal: if the clip were open, selecting everything
  // and nudging it right by one grid step would dispatch a Move Notes
  // command and enable Undo.
  const pianoRoll = page.getByTestId("piano-roll-panel");
  const prBox = await pianoRoll.boundingBox();
  if (prBox === null) throw new Error("piano roll has no box");
  await page.mouse.click(prBox.x + prBox.width / 2, prBox.y + prBox.height / 2);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);

  await expect(
    page.getByRole("button", { name: "Undo" }),
    "Undo should be enabled after nudging the (supposedly open) clip's notes",
  ).toBeEnabled();
});
