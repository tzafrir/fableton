import type { Page } from "@playwright/test";

// M1 "interaction" probe helpers (SS9/SS10): the arrangement lanes and piano
// roll are opaque canvas components (SS15) with no per-note DOM nodes, so an
// e2e spec cannot locate a note by testid the way it locates a toolbar
// button. What IS real and inspectable from outside is the rendered pixels:
// SS9 stacks three <canvas class="fbl-layer-KIND"> elements (grid / content
// / overlay) per editor, and each layer draws in a small, fixed palette
// (src/editor/pianoroll/theme.ts, src/editor/arrangement/constants.ts).
// `scanColorRects` reads a layer's real pixels back with `getImageData` and
// returns the on-screen rectangles of any blob matching a target color — the
// content layer's note fill for "where did the document really put this
// note", the overlay layer's selection/ghost colors for "what does the live
// gesture preview look like right now". Every check in this suite drives the
// UI with real pointer/keyboard events and then reads the SAME pixels a
// human eye would, rather than reaching into module internals this probe is
// not allowed to add (src/ is out of scope for a verifier).

export interface PageErrors {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export function collectPageErrors(page: Page): PageErrors {
  const errors: PageErrors = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.pageErrors.push(String(err)));
  page.on("requestfailed", (req) => {
    errors.failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) errors.failedRequests.push(`${res.request().method()} ${res.url()} — HTTP ${res.status()}`);
  });
  return errors;
}

export interface ColorRect {
  /** CSS px, relative to the scanned CANVAS LAYER's top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** CSS px, absolute page coordinates — feed straight to page.mouse. */
  pageX: number;
  pageY: number;
  pageCenterX: number;
  pageCenterY: number;
}

/**
 * Reads back every same-color connected blob on one SS9 canvas layer inside
 * a panel, as real page pixels. `target` is an [r,g,b] the layer's theme
 * uses (e.g. `theme.noteFill`); canvas composite math means a semi-transparent
 * fill drawn over a fully transparent layer keeps the fill's exact RGB (only
 * alpha varies with SS10's velocity-as-opacity), so an exact-ish RGB match
 * is reliable regardless of note velocity.
 *
 * `excludeBottomCssPx` trims that many CSS px off the BOTTOM of the layer
 * before scanning. The piano roll needs it: `theme.velocityStalk` is the same
 * aqua as `theme.noteFill` and the velocity lane shares the content
 * layer, so an unbounded note scan counts each note TWICE — once as its body
 * and once as its velocity stalk — but only while the note is deselected
 * (a selected note's stalk switches to `velocityStalkSelected`). That makes
 * the miscount intermittent, and it is a probe artifact, not an app defect.
 * See `scanNotes`, which applies the right bound for you.
 */
export async function scanColorRects(
  page: Page,
  containerTestId: string,
  layerKind: "grid" | "content" | "overlay",
  target: readonly [number, number, number],
  opts: { tolerance?: number; minAreaDevicePx?: number; excludeBottomCssPx?: number } = {},
): Promise<ColorRect[]> {
  const tolerance = opts.tolerance ?? 30;
  const minArea = opts.minAreaDevicePx ?? 12;
  const excludeBottomCssPx = opts.excludeBottomCssPx ?? 0;
  const container = page.getByTestId(containerTestId);
  const box = await container.boundingBox();
  if (box === null) throw new Error(`container ${containerTestId} not found/visible`);

  // The editors batch canvas redraws into requestAnimationFrame (SS9's
  // one-repaint-per-frame rule), so the pixels lag a just-committed command by
  // up to a frame. Two rAFs = "the frame after the one currently scheduled",
  // which is the first moment the content layer is guaranteed current. Without
  // this, a scan right after a gesture reads STALE pixels and reports a
  // committed edit as never having happened.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

  const raw = await page.evaluate(
    ({ containerTestId, layerKind, target, tolerance, minArea, excludeBottomCssPx }) => {
      const container = document.querySelector(`[data-testid="${containerTestId}"]`);
      const canvas = container?.querySelector(`canvas.fbl-layer-${layerKind}`) as HTMLCanvasElement | null;
      if (canvas === null || canvas === undefined) return [];
      const rectCss = canvas.getBoundingClientRect();
      const dpr = rectCss.width > 0 ? canvas.width / rectCss.width : 1;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return [];
      const { width, height } = canvas;
      if (width === 0 || height === 0) return [];
      // The layer canvas is NOT flush with the panel container: the
      // arrangement insets its content layers by HEADER_WIDTH_PX(132) /
      // RULER_HEIGHT_PX(26) for the DOM track-header column and the ruler
      // (the piano roll happens to inset by 0). Page coordinates must
      // therefore be measured from the CANVAS, not the container — mapping
      // from the container aims every arrangement click 132px too far left,
      // which lands on the header instead of the clip.
      const originX = rectCss.left;
      const originY = rectCss.top;
      // Rows at or below this are not scanned. See `excludeBottomCssPx`.
      const scanHeight = Math.max(0, height - Math.round(excludeBottomCssPx * dpr));
      const data = ctx.getImageData(0, 0, width, height).data;
      const visited = new Uint8Array(width * height);
      const tol2 = tolerance * tolerance * 3;
      const matches = (i: number): boolean => {
        if ((data[i + 3] as number) < 16) return false;
        const dr = (data[i] as number) - target[0];
        const dg = (data[i + 1] as number) - target[1];
        const db = (data[i + 2] as number) - target[2];
        return dr * dr + dg * dg + db * db <= tol2;
      };
      const out: { x: number; y: number; w: number; h: number; originX: number; originY: number }[] = [];
      const stackX = new Int32Array(width * height);
      const stackY = new Int32Array(width * height);
      for (let y = 0; y < scanHeight; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          if (visited[idx] === 1) continue;
          const i = idx * 4;
          if (!matches(i)) {
            visited[idx] = 1;
            continue;
          }
          let sp = 0;
          stackX[sp] = x;
          stackY[sp] = y;
          sp++;
          visited[idx] = 1;
          let minX = x, maxX = x, minY = y, maxY = y, count = 0;
          while (sp > 0) {
            sp--;
            const cx = stackX[sp] as number;
            const cy = stackY[sp] as number;
            count++;
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
            const nb: [number, number][] = [
              [cx + 1, cy],
              [cx - 1, cy],
              [cx, cy + 1],
              [cx, cy - 1],
            ];
            for (const [nx, ny] of nb) {
              if (nx < 0 || ny < 0 || nx >= width || ny >= scanHeight) continue;
              const nidx = ny * width + nx;
              if (visited[nidx] === 1) continue;
              visited[nidx] = 1;
              if (matches(nidx * 4)) {
                stackX[sp] = nx;
                stackY[sp] = ny;
                sp++;
              }
            }
          }
          if (count >= minArea) {
            out.push({
              x: minX / dpr,
              y: minY / dpr,
              w: (maxX - minX + 1) / dpr,
              h: (maxY - minY + 1) / dpr,
              originX,
              originY,
            });
          }
        }
      }
      return out;
    },
    { containerTestId, layerKind, target, tolerance, minArea, excludeBottomCssPx },
  );

  return raw
    .map(({ originX, originY, ...r }) => ({
      ...r,
      pageX: originX + r.x,
      pageY: originY + r.y,
      pageCenterX: originX + r.x + r.w / 2,
      pageCenterY: originY + r.y + r.h / 2,
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

/** src/editor/pianoroll/layout.ts `VELOCITY_LANE_HEIGHT_PX`. */
export const VELOCITY_LANE_HEIGHT_PX = 72;

/**
 * Piano-roll NOTE rects only: `scanColorRects` on the content layer, bounded
 * to the note area so velocity stalks are not counted as notes (see above).
 */
export async function scanNotes(
  page: Page,
  target: readonly [number, number, number] = NOTE_FILL,
  opts: { tolerance?: number; minAreaDevicePx?: number } = {},
): Promise<ColorRect[]> {
  return scanColorRects(page, "piano-roll-panel", "content", target, {
    ...opts,
    excludeBottomCssPx: VELOCITY_LANE_HEIGHT_PX,
  });
}

/** SS10 theme colors this suite matches against (kept local so no src/ import is needed). */
export const NOTE_FILL: readonly [number, number, number] = [0x35, 0xd0, 0xc8]; // SIGNAL.aqua
export const NOTE_SELECTED_FILL: readonly [number, number, number] = [0xf5, 0xb5, 0x44]; // SIGNAL.amber
export const GHOST_FILL: readonly [number, number, number] = [0xf5, 0xb5, 0x44]; // SIGNAL.amber
export const MARQUEE_FILL: readonly [number, number, number] = [0x35, 0xd0, 0xc8]; // SIGNAL.aqua
export const ARR_CLIP_FILL: readonly [number, number, number] = [0x5b, 0x8d, 0xee]; // TRACK_COLORS[0]

/** Real pointer drag: down at `from`, several intermediate moves, stops
 *  mid-gesture (caller decides mouse-up vs Escape vs more moves). Modifier
 *  keys are held for the whole gesture, the way a user's hand would. */
export async function dragStart(
  page: Page,
  from: { x: number; y: number },
  opts: { mods?: readonly ("Alt" | "Shift" | "Control" | "Meta")[] } = {},
): Promise<void> {
  for (const m of opts.mods ?? []) await page.keyboard.down(m);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A tiny first move so the browser's own drag-threshold heuristics don't
  // coalesce this with the down event.
  await page.mouse.move(from.x + 1, from.y);
}

export async function dragTo(page: Page, to: { x: number; y: number }, steps = 10): Promise<void> {
  await page.mouse.move(to.x, to.y, { steps });
}

export async function dragEnd(
  page: Page,
  opts: { mods?: readonly ("Alt" | "Shift" | "Control" | "Meta")[] } = {},
): Promise<void> {
  await page.mouse.up();
  for (const m of [...(opts.mods ?? [])].reverse()) await page.keyboard.up(m);
}
