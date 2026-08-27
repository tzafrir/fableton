import { readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// M0 render probe, build side: the PRODUCTION build serves the SS12 clock
// worker chunk. The companion of e2e/render/worklet-chunk.spec.ts — that spec
// filters `dist/assets` for `-processor-*.js`, so before this one the clock
// worker was the one emitted entry point never asserted to serve 200.
//
// Why it can 404 without anything else failing: `src/engine/transport/clock.ts`
// constructs it as `new Worker(new URL("../../workers/clock.worker.ts",
// import.meta.url), { type: "module" })`. Vite emits that as a separate chunk
// at build time; if it ever stopped emitting one (a bundler upgrade, the URL
// pattern being refactored into a variable, a base-path change), `new Worker`
// itself would still succeed — construction is async and a failed fetch
// surfaces only as an `error` event on the worker — so `createDefaultClock`
// would hand back a worker clock that never ticks, and playback would produce
// exactly one 200 ms look-ahead window and then stop. The runtime half of that
// is caught by e2e/interaction/clock-worker.spec.ts; this is the cheap,
// direct half.
test("the built clock worker chunk is served with 200, not 404", async ({ page }) => {
  const assetFiles = await readdir("dist/assets");
  const workerFiles = assetFiles.filter((f) => /^clock\.worker-.*\.js$/.test(f));

  expect(
    workerFiles,
    `expected a clock.worker chunk in dist/assets, saw: ${JSON.stringify(assetFiles)}`,
  ).toHaveLength(1);

  await page.goto("/");
  for (const file of workerFiles) {
    const res = await page.request.get(`/assets/${file}`);
    expect(res.status(), `GET /assets/${file}`).toBe(200);
    // A module worker whose response is not JavaScript fails to instantiate;
    // serving it as HTML (an SPA fallback for a missing file) would 200 and
    // still be broken.
    expect(res.headers()["content-type"] ?? "").toMatch(/javascript/);
  }
});
