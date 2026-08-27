import { describe, expect, it, vi } from "vitest";
import { unlockAudioContextOnGesture } from "./unlock";
import type { ResumableAudioContext } from "./unlock";

function makeContext(state: AudioContextState): {
  context: ResumableAudioContext;
  resume: ReturnType<typeof vi.fn>;
} {
  let currentState = state;
  const resume = vi.fn(async () => {
    currentState = "running";
  });
  const context: ResumableAudioContext = {
    get state() {
      return currentState;
    },
    resume,
  };
  return { context, resume };
}

/** Lets the handler's `await context.resume()` continuation run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("unlockAudioContextOnGesture", () => {
  it("does not resume a running context, but stays armed for a later suspension", async () => {
    let currentState: AudioContextState = "running";
    const resume = vi.fn(async () => {
      currentState = "running";
    });
    const context: ResumableAudioContext = {
      get state() {
        return currentState;
      },
      resume,
    };
    const target = document.createElement("div");

    unlockAudioContextOnGesture(context, target);
    target.dispatchEvent(new Event("pointerdown"));
    expect(resume).not.toHaveBeenCalled();

    // The UA suspends the context later (iOS interruption, backgrounded tab):
    // the next gesture must still unlock it — a listener that had already
    // detached itself would leave the app permanently silent.
    currentState = "suspended";
    target.dispatchEvent(new Event("pointerdown"));
    await flushMicrotasks();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(currentState).toBe("running");
  });

  it("resumes on the first gesture event", () => {
    const { context, resume } = makeContext("suspended");
    const target = document.createElement("div");

    unlockAudioContextOnGesture(context, target);
    target.dispatchEvent(new Event("keydown"));

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("only resumes once, even if further gestures fire", () => {
    const { context, resume } = makeContext("suspended");
    const target = document.createElement("div");

    unlockAudioContextOnGesture(context, target);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    target.dispatchEvent(new Event("touchend"));

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("stays armed after a successful resume, so a later suspension recovers", async () => {
    // The module's contract: the listener set outlives the first unlock. A
    // context the UA suspends later (iOS interruption, backgrounded tab) is
    // otherwise silent until a page reload — the exact failure the retry
    // design exists to avoid.
    let currentState: AudioContextState = "suspended";
    const resume = vi.fn(async () => {
      currentState = "running";
    });
    const context: ResumableAudioContext = {
      get state() {
        return currentState;
      },
      resume,
    };
    const target = document.createElement("div");
    const removeSpy = vi.spyOn(target, "removeEventListener");

    unlockAudioContextOnGesture(context, target);
    target.dispatchEvent(new Event("pointerdown"));
    await flushMicrotasks();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(currentState).toBe("running");
    expect(removeSpy).not.toHaveBeenCalled(); // nothing detached itself

    currentState = "suspended"; // the UA pulled the context out from under us
    target.dispatchEvent(new Event("pointerdown"));
    await flushMicrotasks();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(currentState).toBe("running");
  });

  it("detaches every gesture listener through the returned unsub", () => {
    const { context } = makeContext("suspended");
    const target = document.createElement("div");
    const removeSpy = vi.spyOn(target, "removeEventListener");

    const unsub = unlockAudioContextOnGesture(context, target);
    expect(removeSpy).not.toHaveBeenCalled();
    unsub();
    // One removeEventListener call per gesture event type registered.
    expect(removeSpy).toHaveBeenCalledTimes(3);
    unsub(); // idempotent
    expect(removeSpy).toHaveBeenCalledTimes(3);
  });

  it("re-arms when a resume resolves with the context still suspended (Safari)", async () => {
    const target = document.createElement("div");
    let currentState: AudioContextState = "suspended";
    let attempts = 0;
    const resume = vi.fn(async () => {
      attempts++;
      // The first gesture's resume does not stick; the second one does.
      if (attempts > 1) currentState = "running";
    });
    const context: ResumableAudioContext = {
      get state() {
        return currentState;
      },
      resume,
    };

    unlockAudioContextOnGesture(context, target);
    target.dispatchEvent(new Event("pointerdown"));
    await flushMicrotasks();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(currentState).toBe("suspended");

    target.dispatchEvent(new Event("pointerdown"));
    await flushMicrotasks();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(currentState).toBe("running");
  });

  it("re-arms after a rejected resume instead of going silent forever", async () => {
    const target = document.createElement("div");
    const resume = vi.fn(() => Promise.reject(new Error("boom")));
    const context: ResumableAudioContext = { state: "suspended", resume };

    unlockAudioContextOnGesture(context, target);
    target.dispatchEvent(new Event("pointerdown"));
    await flushMicrotasks();
    target.dispatchEvent(new Event("keydown"));
    await flushMicrotasks();

    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("supports detaching early via the returned unsub, before any gesture", () => {
    const { context, resume } = makeContext("suspended");
    const target = document.createElement("div");

    const unsub = unlockAudioContextOnGesture(context, target);
    unsub();
    target.dispatchEvent(new Event("pointerdown"));

    expect(resume).not.toHaveBeenCalled();
  });

  it("swallows a rejecting resume() without throwing out of the handler", async () => {
    const target = document.createElement("div");
    const context: ResumableAudioContext = {
      state: "suspended",
      resume: vi.fn(() => Promise.reject(new Error("boom"))),
    };

    unlockAudioContextOnGesture(context, target);
    expect(() => target.dispatchEvent(new Event("pointerdown"))).not.toThrow();

    // let the rejected promise's .catch() settle before the test ends
    await Promise.resolve();
    await Promise.resolve();
  });
});
