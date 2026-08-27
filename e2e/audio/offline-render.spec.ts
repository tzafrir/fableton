import { expect, test } from "@playwright/test";

// SS15's testing strategy, verbatim: "the engine runs headless against
// `OfflineAudioContext` in integration tests (schedule a clip, render,
// assert on the buffer)". jsdom (Vitest's environment) has no Web Audio
// implementation at all, so this is where that proof actually happens: a
// real `OfflineAudioContext` inside headless Chromium renders the SS18-M0
// hard-coded clip through the registered `core.poly-synth -> core.filter ->
// destination` chain, and the resulting buffer must not be silence.
test("hard-coded demo clip renders a non-silent buffer through synth -> filter -> destination", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const bridge = window.__fabletonDemo;
    if (!bridge) throw new Error("window.__fabletonDemo bridge missing — check src/main.tsx");
    return bridge.renderDemoOffline();
  });

  expect(result.durationSeconds).toBeGreaterThan(1);
  expect(result.sampleRate).toBeGreaterThan(0);
  // Successive look-ahead windows, not one fill-everything pass: the scheduler
  // clock ticked many times WHILE the render was under way, which is the SS12
  // handoff (window -> port message -> worklet queue) the live app runs on.
  expect(result.ticks).toBeGreaterThan(10);
  // Well above float rounding noise — real audio from the worklet synth
  // through a lowpass filter, not silence.
  expect(result.peakAbs).toBeGreaterThan(0.01);
  expect(result.rms).toBeGreaterThan(0.001);
  // ...and it is not DISTORTED either: the phrase's release overlaps every
  // note boundary, so two voices sum, and the destination hard-clips anything
  // past full scale on real hardware. `createDemoEngine` leaves headroom.
  expect(result.peakAbs).toBeLessThan(1);
  expect(result.clippedSamples).toBe(0);

  // ...and it is the WHOLE CLIP, not one blast at t=0 and not the first
  // second of it: SS12 has every note reach the instrument with its own
  // `AudioContext` timestamp, arriving over successive look-ahead windows, so
  // energy must be present in EVERY one of the eight note slots. Asserting
  // only "something loud early, something loud in the middle" would pass a
  // scheduler that stopped opening windows after ~1 s and dropped the phrase's
  // second half — the exact failure this proof exists to catch.
  const windows = result.windowRms;
  const windowSeconds = result.durationSeconds / windows.length;
  const loud = (rms: number): boolean => rms > result.rms * 0.25;
  // `demoClipDurationSeconds` renders the clip plus a 0.5 s release tail.
  const clipSeconds = result.durationSeconds - 0.5;
  const NOTE_COUNT = 8; // DEMO_CLIP: eight eighth notes at 120 bpm
  const noteSeconds = clipSeconds / NOTE_COUNT;
  for (let n = 0; n < NOTE_COUNT; n++) {
    const from = Math.floor((n * noteSeconds) / windowSeconds);
    const to = Math.ceil(((n + 1) * noteSeconds) / windowSeconds);
    const slot = windows.slice(from, to);
    expect(slot.some(loud), `note ${String(n)} (windows ${String(from)}..${String(to)})`).toBe(
      true,
    );
  }
  // The clip is 2 s of a 2.5 s render; the last window is release tail only.
  expect(loud(windows.at(-1)!)).toBe(false);
});


// SS4 fast path A, proved against RENDERED SAMPLES rather than recorded
// `AudioParam` events: the same clip rendered twice, differing only in the
// value written through the cutoff `ParamHandle`, must come back with
// different high-frequency content. That fails if `core.filter` is mounted
// but out of the audio path, if the handle is bound to the wrong
// `AudioParam`, or if the write never reaches the node at all — none of which
// any level-only assertion can see.
test("the filter's cutoff changes the rendered spectrum (SS4 fast path A)", async ({ page }) => {
  await page.goto("/");

  const { dark, bright } = await page.evaluate(async () => {
    const bridge = window.__fabletonDemo;
    if (!bridge) throw new Error("window.__fabletonDemo bridge missing — check src/main.tsx");
    // Sequentially: each render builds its own `OfflineAudioContext`.
    const darkRender = await bridge.renderDemoOffline({ cutoffHz: 100 });
    const brightRender = await bridge.renderDemoOffline({ cutoffHz: 12000 });
    return { dark: darkRender, bright: brightRender };
  });

  expect(dark.cutoffHz).toBe(100);
  expect(bright.cutoffHz).toBe(12000);
  // Both renders are real audio — the dark one is filtered, not silenced.
  expect(dark.rms).toBeGreaterThan(0.001);
  expect(bright.rms).toBeGreaterThan(0.001);
  // The phrase sits well above 100 Hz, so a lowpass down there takes most of
  // its energy with it, and what is left is proportionally darker. Both
  // factors are deliberately loose (measured: ~8x level, ~1.8x HF share) —
  // what is being asserted is that the filter is IN the path with its cutoff
  // bound to the right `AudioParam`, not a response curve.
  expect(bright.rms).toBeGreaterThan(dark.rms * 4);
  expect(bright.hfRatio).toBeGreaterThan(dark.hfRatio * 1.3);
});
