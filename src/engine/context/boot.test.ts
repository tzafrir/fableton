// See audioContext.test.ts for why AudioContext is stubbed rather than real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootAudioContext } from "./boot";

function makeFakeAudioContext(options: { resumeSucceeds: boolean }) {
  return class FakeAudioContext {
    readonly audioWorklet = { addModule: vi.fn(async (_url: string) => {}) };
    state: AudioContextState = "suspended";
    resume = vi.fn(async () => {
      if (options.resumeSucceeds) {
        this.state = "running";
      } else {
        throw new Error("NotAllowedError: still locked");
      }
    });
    constructor(_options?: AudioContextOptions) {}
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootAudioContext", () => {
  it("returns a running context when the immediate resume() succeeds", async () => {
    vi.stubGlobal("AudioContext", makeFakeAudioContext({ resumeSucceeds: true }));
    const target = document.createElement("div");
    const addSpy = vi.spyOn(target, "addEventListener");

    const context = await bootAudioContext({ gestureTarget: target });

    expect(context.state).toBe("running");
    // The immediate resume already unlocked it, but the gesture listeners stay
    // armed: a context the UA suspends later (iOS interruption, backgrounded
    // tab) must still be recoverable without a page reload. They cost a state
    // read per gesture and never call `resume()` while it is running.
    expect(addSpy).toHaveBeenCalledTimes(3);
  });

  it("wires the gesture fallback when the immediate resume() does not stick", async () => {
    vi.stubGlobal("AudioContext", makeFakeAudioContext({ resumeSucceeds: false }));
    const target = document.createElement("div");

    const context = await bootAudioContext({ gestureTarget: target });
    expect(context.state).toBe("suspended");

    // Simulate the resumeSucceeds flip that a real Safari `resume()`, called
    // from inside a genuine gesture event, would produce.
    (context as unknown as { resume: () => Promise<void> }).resume = vi.fn(async () => {
      (context as unknown as { state: AudioContextState }).state = "running";
    });
    target.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    await Promise.resolve();

    expect(context.state).toBe("running");
  });

  it("does not reject even when resume() never succeeds", async () => {
    vi.stubGlobal("AudioContext", makeFakeAudioContext({ resumeSucceeds: false }));
    const target = document.createElement("div");

    await expect(bootAudioContext({ gestureTarget: target })).resolves.toBeDefined();
  });

  it("defaults the gesture target to window when none is given", async () => {
    vi.stubGlobal("AudioContext", makeFakeAudioContext({ resumeSucceeds: false }));
    const addSpy = vi.spyOn(window, "addEventListener");

    await bootAudioContext();

    expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function));
    addSpy.mockRestore();
  });

  it("replaces the previous boot's gesture listeners instead of stacking them", async () => {
    // The unlock listeners stay armed for the life of their context (see
    // ./unlock), and each boot builds a NEW context — so a re-boot must take
    // the old set down, or every remount leaks one.
    vi.stubGlobal("AudioContext", makeFakeAudioContext({ resumeSucceeds: true }));
    const first = document.createElement("div");
    const removeFirst = vi.spyOn(first, "removeEventListener");
    await bootAudioContext({ gestureTarget: first });
    expect(removeFirst).not.toHaveBeenCalled();

    const second = document.createElement("div");
    const addSecond = vi.spyOn(second, "addEventListener");
    await bootAudioContext({ gestureTarget: second });

    expect(removeFirst).toHaveBeenCalledTimes(3); // the first set is gone
    expect(addSecond).toHaveBeenCalledTimes(3); // ...and only the new one is armed
  });

  it("passes latencyHint through to context creation", async () => {
    const FakeAudioContext = makeFakeAudioContext({ resumeSucceeds: true });
    const captured: AudioContextOptions[] = [];
    class RecordingAudioContext extends FakeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        if (options) {
          captured.push(options);
        }
      }
    }
    vi.stubGlobal("AudioContext", RecordingAudioContext);

    await bootAudioContext({ latencyHint: "playback", gestureTarget: document.createElement("div") });

    expect(captured).toEqual([{ latencyHint: "playback" }]);
  });
});
