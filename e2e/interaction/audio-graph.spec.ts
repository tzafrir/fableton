import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

// M0 "interaction" acceptance probe: drives the real UI (Boot audio -> Play
// -> Stop) in a real browser against a PRODUCTION build (`vite preview`,
// see playwright.config.ts) and proves each step for real, not just that a
// promise resolved:
//
//   1. clicking "Boot audio" really unlocks the live AudioContext
//      (`.state === 'running'`), not just that the status text changed;
//   2. clicking "Play" really produces sound — tapped straight off the live
//      audio graph with an AnalyserNode, not inferred from UI state;
//   3. clicking "Stop" really silences the graph (SS12 allNotesOff) within
//      ~200ms, not just that the transport label flips to "stopped";
//   4. no console errors / unhandled rejections anywhere in that flow.
//
// The app (src/app/App.tsx, src/demo/engine.ts) does not expose its
// internal nodes to the page for testing — by design (SS4: "the AudioParam
// goes INTO the handle and never comes back out"). Rather than add a test
// hook to src/ (out of scope for a verifier), this spec taps the graph the
// same way any external analyzer would: an `init script` installed before
// the page's own scripts run, patching `AudioNode.prototype.connect` to
// notice the one connection every chain in this app must eventually make —
// something connecting into `ctx.destination` — and silently branching an
// `AnalyserNode` off it. The original connection is untouched; the tap is
// read-only.
async function installAudioTap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __audioTap?: {
        context: BaseAudioContext;
        analyser: AnalyserNode;
        data: Float32Array<ArrayBuffer>;
      };
      __audioContexts: AudioContextState[];
    };
    w.__audioContexts = [];

    const OrigConnect = AudioNode.prototype.connect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AudioNode.prototype as any).connect = function (
      this: AudioNode,
      target: unknown,
      ...rest: unknown[]
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (OrigConnect as any).call(this, target, ...rest);
      try {
        if (
          typeof AudioDestinationNode !== "undefined" &&
          target instanceof AudioDestinationNode
        ) {
          const ctx = target.context;
          if (!w.__audioTap || w.__audioTap.context !== ctx) {
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0;
            w.__audioTap = {
              context: ctx,
              analyser,
              data: new Float32Array(analyser.fftSize),
            };
          }
          // Read-only branch: the analyser has no downstream connection of
          // its own, so this cannot change what the destination actually
          // hears.
          this.connect(w.__audioTap.analyser);
        }
      } catch {
        // Never let the tap itself break the app under test.
      }
      return result;
    };

    // Every AudioContext this page constructs, in creation order, so the
    // "unlock -> running" check can read `.state` off the real instance the
    // app is using — not a guess based on timing.
    const OrigAudioContext = window.AudioContext;
    class TappedAudioContext extends OrigAudioContext {
      constructor(...args: ConstructorParameters<typeof OrigAudioContext>) {
        super(...args);
        (window as unknown as { __lastAudioContext?: AudioContext }).__lastAudioContext =
          this;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).AudioContext = TappedAudioContext;
  });
}

function tapRms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __audioTap?: { analyser: AnalyserNode; data: Float32Array<ArrayBuffer> };
    };
    const tap = w.__audioTap;
    if (!tap) return -1;
    tap.analyser.getFloatTimeDomainData(tap.data);
    let sumSquares = 0;
    for (let i = 0; i < tap.data.length; i++) {
      const v = tap.data[i]!;
      sumSquares += v * v;
    }
    return Math.sqrt(sumSquares / tap.data.length);
  });
}

const SCREENSHOT_DIR = path.join(process.cwd(), ".playwright/screenshots/M0/interaction");

test.describe("audio graph: boot -> play -> stop", () => {
  test("boot unlocks the real AudioContext, play produces real sound, stop silences it, no console errors", async ({
    page,
  }, testInfo) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("requestfailed", (req) => {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    });

    await installAudioTap(page);
    await page.goto("/");

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-loaded.png") });

    // Real content, not a blank/unmounted page.
    await expect(page.getByRole("heading", { name: "Fableton" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Boot audio" })).toBeVisible();

    // --- 1. Boot: the AudioContext really reaches 'running' -----------------
    await page.getByRole("button", { name: "Boot audio" }).click();
    await expect(page.getByTestId("audio-status")).toHaveText(/^ready \(worklet loaded/, {
      timeout: 10_000,
    });

    const contextState = await page.evaluate(
      () => (window as unknown as { __lastAudioContext?: AudioContext }).__lastAudioContext?.state,
    );
    expect(contextState).toBe("running");

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-booted.png") });

    // The tap must actually be wired (i.e. something connected to
    // ctx.destination) before the play/stop assertions mean anything.
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __audioTap?: unknown }).__audioTap)), {
        timeout: 5_000,
      })
      .toBe(true);

    // Silence before Play: the graph is wired but nothing has fired yet.
    const preplayRms = await tapRms(page);
    expect(preplayRms).toBeGreaterThanOrEqual(0);
    expect(preplayRms).toBeLessThan(0.01);

    // --- 2. Play: real, non-zero energy at multiple points across the clip -
    // DEMO_CLIP (src/demo/clip.ts) is an 8-note, 120bpm eighth-note phrase —
    // 2s long, 250ms/note. Sample RMS across that whole span so a single
    // lucky/unlucky instant can't decide the check either way.
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByTestId("transport-state")).toHaveText("playing");

    const samples: number[] = [];
    const sampleTimesMs = [150, 500, 900, 1300, 1700];
    for (const t of sampleTimesMs) {
      await page.waitForTimeout(t === sampleTimesMs[0] ? t : t - sampleTimesMs[sampleTimesMs.indexOf(t) - 1]!);
      samples.push(await tapRms(page));
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-playing.png") });

    // At least most sample points must show real energy — this is the
    // non-silence proof for the live graph, not the offline render.
    const loudCount = samples.filter((rms) => rms > 0.01).length;
    expect(
      loudCount,
      `expected most of the ${samples.length} samples across the clip to be loud; got RMS=${JSON.stringify(samples)}`,
    ).toBeGreaterThanOrEqual(Math.ceil(samples.length * 0.6));
    // And it must be real signal, not e.g. DC offset noise from the tap:
    // some peak comfortably above the noise floor.
    expect(Math.max(...samples)).toBeGreaterThan(0.02);

    // --- 3. Stop: transport stops and the graph decays to silence quickly --
    const rmsAtStop = await tapRms(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByTestId("transport-state")).toHaveText("stopped");

    // SS12: stop() sends allNotesOff(now + epsilon). Up to 200ms of note-ons
    // are already inside the worklet's queue at that moment; they must be
    // CANCELLED, not merely released after they attack. A decaying tail can
    // only fall, so a level that climbs after Stop is a ghost note attacking.
    const afterStop: number[] = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(25);
      afterStop.push(await tapRms(page));
    }
    const ceiling = Math.max(rmsAtStop, 0.02) * 1.15;
    expect(
      Math.max(...afterStop),
      `no note may attack after Stop; RMS at stop=${rmsAtStop}, after=${JSON.stringify(afterStop)}`,
    ).toBeLessThanOrEqual(ceiling);

    // ...and the release tail decays away.
    await expect
      .poll(() => tapRms(page), { timeout: 500, intervals: [50, 50, 50, 50, 50] })
      .toBeLessThan(0.01);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-stopped.png") });

    // Stays silent — no stuck notes ringing on after the poll succeeded.
    await page.waitForTimeout(150);
    const postStopRms = await tapRms(page);
    expect(postStopRms).toBeLessThan(0.01);

    // --- 4. No console errors / unhandled rejections across the whole flow -
    await testInfo.attach("console-errors", { body: JSON.stringify(consoleErrors, null, 2) });
    await testInfo.attach("page-errors", { body: JSON.stringify(pageErrors, null, 2) });
    await testInfo.attach("failed-requests", { body: JSON.stringify(failedRequests, null, 2) });

    expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
    expect(pageErrors, `page errors / unhandled rejections: ${JSON.stringify(pageErrors)}`).toEqual([]);
    expect(failedRequests, `failed network requests: ${JSON.stringify(failedRequests)}`).toEqual([]);
  });
});
