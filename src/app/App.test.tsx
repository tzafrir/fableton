// The shipped app's own seam tests (SS15: "no browser needed for any of the
// load-bearing logic"). The cutoff control is M0's only live write path into
// the engine — SS3 fast path A: a gesture writes through `ParamHandle.setLive`
// at gesture rate with no document churn, and gesture END commits exactly one
// value. jsdom plus a real `ParamRegistry` (with a fake `AudioParam` standing
// in for the DSP node) covers all of it; only the AudioContext itself is
// stubbed, because jsdom has no Web Audio at all.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createParamRegistry, p } from "../params";
import type { ParamCommit } from "../params";
import { FakeAudioParam } from "../devices/harness/testing/fakeAudio";
import type { DemoEngine } from "../demo";
import { DEMO_CUTOFF_PARAM_ID } from "../demo/engine";
import { App } from "./App";

const bootAudioContext = vi.fn();
const createDemoEngine = vi.fn();

vi.mock("../engine/context", () => ({
  bootAudioContext: (...args: unknown[]) => bootAudioContext(...args) as unknown,
}));

vi.mock("../demo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../demo")>();
  return {
    ...actual,
    createDemoEngine: (...args: unknown[]) => createDemoEngine(...args) as unknown,
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("smoke", () => {
  it("runs in a jsdom + Vitest environment", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
  });

  it("renders the App placeholder without throwing", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Fableton");
  });

  it("renders Boot/Play/Stop, with Play and Stop disabled before boot", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain(">Boot audio<");
    expect(html).toMatch(/>Play<\/button>/);
    expect(html).toMatch(/>Stop<\/button>/);
    // Play/Stop are disabled until `createDemoEngine` resolves post-boot.
    const playButton = html.match(/<button[^>]*>Play<\/button>/)?.[0];
    const stopButton = html.match(/<button[^>]*>Stop<\/button>/)?.[0];
    expect(playButton).toContain("disabled");
    expect(stopButton).toContain("disabled");
  });
});

describe("App — the live cutoff control (SS3 fast path A)", () => {
  const CUTOFF = p.hz(DEMO_CUTOFF_PARAM_ID, "Cutoff", { min: 40, max: 18000, default: 1200 });

  let container: HTMLDivElement;
  let root: Root;
  let registry: ReturnType<typeof createParamRegistry>;
  let audioParam: FakeAudioParam;
  let commits: ParamCommit[];
  let transportCalls: string[];
  let disposed: number;

  /** A `DemoEngine` whose params really are a `ParamRegistry` with a handle
   *  bound to a (fake) `AudioParam` — so the test sees what the DSP sees. */
  function makeEngine(): DemoEngine {
    registry = createParamRegistry({ now: () => 0 });
    const handle = registry.register(CUTOFF);
    audioParam = new FakeAudioParam("cutoff", CUTOFF.defaultValue);
    handle.bindAudioParam(audioParam as unknown as AudioParam);
    registry.onCommit((commit) => commits.push(commit));
    return {
      transport: {
        play: () => transportCalls.push("play"),
        stop: () => transportCalls.push("stop"),
        onStateChange: () => () => {},
      } as unknown as DemoEngine["transport"],
      params: registry,
      onParamCommit: (cb) => registry.onCommit(cb),
      dispose: () => {
        disposed++;
      },
    };
  }

  /** Fires the native input event React's `onChange` listens for on a range. */
  function drag(value: number): void {
    const input = container.querySelector<HTMLInputElement>("[data-testid=filter-cutoff]")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(value));
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function releaseGesture(): void {
    const input = container.querySelector("[data-testid=filter-cutoff]")!;
    act(() => {
      input.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
  }

  function readout(): string {
    return container.querySelector("[data-testid=filter-cutoff-value]")!.textContent ?? "";
  }

  function sliderPosition(): number {
    return Number(
      container.querySelector<HTMLInputElement>("[data-testid=filter-cutoff]")!.value,
    );
  }

  async function boot(): Promise<void> {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Boot audio",
    )!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    commits = [];
    transportCalls = [];
    disposed = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    bootAudioContext.mockResolvedValue({ state: "running", destination: {} });
    createDemoEngine.mockImplementation(() => Promise.resolve(makeEngine()));
    act(() => {
      root.render(<App />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("seeds the control from the live value once the engine is up", async () => {
    expect(container.querySelector<HTMLInputElement>("[data-testid=filter-cutoff]")!.disabled).toBe(
      true,
    );
    await boot();
    expect(container.querySelector<HTMLInputElement>("[data-testid=filter-cutoff]")!.disabled).toBe(
      false,
    );
    expect(readout()).toBe(CUTOFF.toText(CUTOFF.defaultValue));
    expect(disposed).toBe(0);
  });

  it("a drag reaches the DSP through setLive, without committing", async () => {
    await boot();
    drag(0.25);

    const expected = registry.require(DEMO_CUTOFF_PARAM_ID).live();
    expect(expected).not.toBe(CUTOFF.defaultValue);
    // The value the DSP actually sees — the whole point of fast path A.
    expect(audioParam.scheduled).toBeCloseTo(expected, 6);
    expect(readout()).toBe(CUTOFF.toText(expected));
    // ...and nothing has reached the document yet (SS3: no document churn
    // during the gesture).
    expect(commits).toEqual([]);
    expect(registry.require(DEMO_CUTOFF_PARAM_ID).base()).toBe(CUTOFF.defaultValue);
  });

  it("gesture end commits exactly one value (one gesture = one undo entry)", async () => {
    await boot();
    drag(0.25);
    drag(0.5);
    drag(0.75);
    expect(commits).toEqual([]);

    releaseGesture();

    const handle = registry.require(DEMO_CUTOFF_PARAM_ID);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.id).toBe(DEMO_CUTOFF_PARAM_ID);
    expect(commits[0]!.value).toBe(handle.live());
    expect(commits[0]!.previous).toBe(CUTOFF.defaultValue);
    expect(handle.base()).toBe(handle.live());
  });

  it("repaints from a write it did not make (the read half of the bridge)", async () => {
    await boot();
    const handle = registry.require(DEMO_CUTOFF_PARAM_ID);

    // An automation-path write (M3), or a `load()` from undo: nothing to do
    // with this input, but the control must follow it.
    act(() => {
      handle.setLive(400, "automation");
      registry.flushChanges(); // the rAF coalescing SS4 specifies
    });

    expect(readout()).toBe(CUTOFF.toText(400));
    expect(sliderPosition()).toBeGreaterThan(0);
    expect(sliderPosition()).toBeLessThan(1);
  });

  it("boots once even when the button is clicked twice in the same frame", async () => {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Boot audio",
    )!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // A second AudioContext + device chain would otherwise leak, silently.
    expect(bootAudioContext).toHaveBeenCalledTimes(1);
    expect(createDemoEngine).toHaveBeenCalledTimes(1);
  });

  it("disposes the engine when the component unmounts", async () => {
    // Without this the transport's 25 ms worker clock keeps ticking, the
    // AudioContext stays open and the worklet nodes stay connected to
    // `destination` for the rest of the page's life (SS12 lifecycle).
    await boot();
    expect(disposed).toBe(0);

    act(() => {
      root.unmount();
    });

    expect(disposed).toBe(1);
    // `afterEach` unmounts again; a second unmount must not re-dispose.
    root = createRoot(container);
  });

  it("re-arms the Boot button after a failed boot", async () => {
    // `bootingRef` guards the in-flight window only. Latching it on failure
    // would leave a clickable-looking button that dead-ends at the guard, with
    // no way back to audio short of a page reload.
    bootAudioContext.mockRejectedValueOnce(new Error("addModule 404"));
    await boot();
    expect(container.querySelector("[data-testid=audio-status]")!.textContent).toContain(
      "failed:",
    );

    await boot();

    expect(bootAudioContext).toHaveBeenCalledTimes(2);
    expect(createDemoEngine).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid=audio-status]")!.textContent).toContain("ready");
  });

  it("Play and Stop drive the transport once ready", async () => {
    await boot();
    for (const label of ["Play", "Stop"]) {
      const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === label,
      )!;
      act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    expect(transportCalls).toEqual(["play", "stop"]);
  });
});
