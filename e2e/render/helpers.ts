import { expect, type Page } from "@playwright/test";

/**
 * Render-suite helper: attaches listeners that collect every console error,
 * uncaught page exception, and failed/non-2xx network response seen while
 * the page is open. Used by every spec in this suite so "zero console
 * errors, zero uncaught exceptions, zero failed asset requests" (M0 render
 * probe check 1) is actually enforced on every flow, not just the smoke
 * test.
 */
export interface PageErrors {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export function collectPageErrors(page: Page): PageErrors {
  const errors: PageErrors = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    errors.pageErrors.push(String(err));
  });

  page.on("requestfailed", (req) => {
    errors.failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown error"}`);
  });

  page.on("response", (res) => {
    // Ignore the dev/preview server's own navigation redirects and anything
    // not same-origin static content; a >=400 on any asset/document request
    // is a real failure.
    if (res.status() >= 400) {
      errors.failedRequests.push(`${res.request().method()} ${res.url()} — HTTP ${res.status()}`);
    }
  });

  return errors;
}

/**
 * Boots the audio engine the way a real user does (a click satisfies the
 * autoplay-gesture requirement even with `--autoplay-policy=no-user-gesture-
 * required`) and waits for the M1 `ProjectEngine` to report ready. Shared by
 * every M1 render spec that needs a live engine (playhead/transport checks).
 */
export async function bootAudio(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Boot audio" }).click();
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded, state=running\)$/, {
    timeout: 10_000,
  });
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Reads a BOUNDED device-pixel RGBA region of one 2D canvas. Deliberately
 * region-scoped, not whole-canvas: a full DPR-2 layer canvas is ~2-3
 * megapixels, and shipping that many numbers back across the Playwright
 * protocol as a JSON array (rather than counting in-browser) is what made an
 * earlier version of this suite blow its 30s test timeout on a single
 * `getImageData`. Ask for only the window you actually need.
 */
export async function readCanvasRegionPixels(
  page: Page,
  containerTestId: string,
  layerClass: string,
  region: { x: number; y: number; width: number; height: number },
): Promise<{ width: number; height: number; data: number[] }> {
  const result = await page.evaluate(
    ({ containerTestId, layerClass, region }) => {
      const panel = document.querySelector(`[data-testid="${containerTestId}"]`);
      const canvas = panel?.querySelector<HTMLCanvasElement>(`.${layerClass}`);
      if (!canvas) throw new Error(`no canvas .${layerClass} inside [data-testid="${containerTestId}"]`);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const img = ctx.getImageData(region.x, region.y, region.width, region.height);
      return { width: img.width, height: img.height, data: Array.from(img.data) };
    },
    { containerTestId, layerClass, region },
  );
  return result;
}

/**
 * Counts device pixels in a canvas layer whose color is within `tolerance`
 * (summed |Δr|+|Δg|+|Δb|) of `target`, entirely inside the page — so a
 * multi-megapixel canvas costs one number over the wire, not one JSON array
 * per pixel. Samples every `stride`th pixel (both axes) for speed; the exact
 * count doesn't matter, only "present in bulk" vs "absent".
 */
export async function countMatchingPixels(
  page: Page,
  containerTestId: string,
  layerClass: string,
  target: { r: number; g: number; b: number },
  tolerance: number,
  stride = 1,
): Promise<number> {
  return page.evaluate(
    ({ containerTestId, layerClass, target, tolerance, stride }) => {
      const panel = document.querySelector(`[data-testid="${containerTestId}"]`);
      const canvas = panel?.querySelector<HTMLCanvasElement>(`.${layerClass}`);
      if (!canvas) throw new Error(`no canvas .${layerClass} inside [data-testid="${containerTestId}"]`);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let count = 0;
      for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
          const i = (y * width + x) * 4;
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          const a = data[i + 3] ?? 0;
          if (a === 0) continue;
          if (Math.abs(r - target.r) + Math.abs(g - target.g) + Math.abs(b - target.b) <= tolerance) count += 1;
        }
      }
      return count;
    },
    { containerTestId, layerClass, target, tolerance, stride },
  );
}

/**
 * Longest vertical run of same-color device pixels at a fixed x — approximates
 * row-band height for a "did vertical zoom actually change the layout"
 * assertion, without shipping the column's data back to compute it in Node.
 */
export async function longestVerticalRun(
  page: Page,
  containerTestId: string,
  layerClass: string,
  x: number,
): Promise<number> {
  return page.evaluate(
    ({ containerTestId, layerClass, x }) => {
      const panel = document.querySelector(`[data-testid="${containerTestId}"]`);
      const canvas = panel?.querySelector<HTMLCanvasElement>(`.${layerClass}`);
      if (!canvas) throw new Error(`no canvas .${layerClass} inside [data-testid="${containerTestId}"]`);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let best = 0;
      let current = 0;
      let prevKey = "";
      for (let y = 0; y < height; y += 1) {
        const i = (y * width + x) * 4;
        const key = `${String(data[i])},${String(data[i + 1])},${String(data[i + 2])}`;
        if (key === prevKey) current += 1;
        else {
          if (current > best) best = current;
          current = 1;
          prevKey = key;
        }
      }
      return Math.max(best, current);
    },
    { containerTestId, layerClass, x },
  );
}

export function pixelAt(buf: { width: number; data: number[] }, x: number, y: number): Rgba {
  const i = (y * buf.width + x) * 4;
  return { r: buf.data[i] ?? 0, g: buf.data[i + 1] ?? 0, b: buf.data[i + 2] ?? 0, a: buf.data[i + 3] ?? 0 };
}

/** Euclidean-ish channel distance, ignoring alpha (both samples are opaque grid fills). */
export function colorDelta(a: Rgba, b: Rgba): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}
