import { readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { collectPageErrors } from "./helpers";

// M0 render probe check 3: the PRODUCTION build actually serves the
// AudioWorklet module(s). SS15 calls worklet bundling "the only nonstandard
// bit" of the build — this proves it against the built/served output (this
// suite always runs against `vite preview` over a `vite build`, per
// playwright.config.ts), not merely against `vite dev`.
//
// One worklet module is wired in M0: src/devices/core/polySynth.ts imports
// its processor with `?worker&url` and `prepare()` hands that URL to
// `audioWorklet.addModule` when the demo chain mounts the instrument (SS7
// "prepare: one-time async setup per context"). The worklet seam is proved by
// the device that actually needs one — there is no scaffolding processor in
// the shipped bundle.
//
// Note on how this is verified: Chromium does not expose
// AudioWorkletGlobalScope as an inspectable CDP target the way it does
// DedicatedWorker, so `page.on("response")` / a `Network`-domain CDP
// session on the page never observes the `addModule()` fetch itself (this
// was confirmed by instrumenting both approaches against a real boot click
// during authoring — zero worklet-chunk entries either way, only the main
// document and the index chunk). So this test proves the requirement two
// ways instead: (1) directly, via HTTP request against every worklet chunk
// the build actually emitted (found by reading `dist/assets/`, so it can't
// pass against a filename that no longer exists), and (2) functionally — the
// poly-synth device's `prepare()` awaits `addModule(...)` and throws on
// failure, which `handleBoot` (src/app/App.tsx) catches into a
// `"failed: ..."` status — so the app only ever reaches `"ready (worklet
// loaded, state=running)"` if that `addModule` resolved, i.e. the chunk was
// fetched with 200.
test("built worklet chunks are served with 200, not 404", async ({ page }) => {
  const assetFiles = await readdir("dist/assets");
  const workletFiles = assetFiles.filter((f) => /-processor-.*\.js$/.test(f));

  expect(workletFiles, `expected worklet processor chunks in dist/assets, saw: ${JSON.stringify(assetFiles)}`).not.toHaveLength(0);
  expect(workletFiles.some((f) => f.startsWith("poly-synth-processor-"))).toBe(true);

  await page.goto("/");
  for (const file of workletFiles) {
    const res = await page.request.get(`/assets/${file}`);
    expect(res.status(), `GET /assets/${file}`).toBe(200);
  }
});

test("booting the app resolves the addModule() call end to end (functional proof)", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Boot audio" }).click();

  // `handleBoot` only reaches this status string after the demo chain's
  // device mount has awaited `context.audioWorklet.addModule(...)` for the
  // poly-synth processor without throwing. A 404/failed fetch for the worklet
  // module would instead land on `status === "failed: ..."`.
  await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded, state=running\)$/, {
    timeout: 10_000,
  });

  expect(errors.consoleErrors, "console errors").toEqual([]);
  expect(errors.pageErrors, "uncaught page exceptions").toEqual([]);
  expect(errors.failedRequests, "failed/non-2xx network requests").toEqual([]);
});
