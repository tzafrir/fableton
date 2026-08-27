// The audio-boot entry point: creation + the SS12 unlock guardrail, in one
// call.
//
// Returns `BaseAudioContext` on purpose, not `AudioContext` — every other
// package in the app (device `create(ctx, io)`, the reconciler, the
// scheduler) is written against `BaseAudioContext` so the identical call
// sites keep working when M4's offline export substitutes an
// `OfflineAudioContext` (SS12: "reconciler already targets
// `BaseAudioContext`"). `bootAudioContext` is the one seam allowed to know
// the concrete instance is a real `AudioContext`; callers that specifically
// need the resumable/closable surface should use `createAudioContext`
// directly instead.

import type { Unsub } from "../../types";
import { createAudioContext } from "./audioContext";
import type { CreateAudioContextOptions } from "./audioContext";
import { unlockAudioContextOnGesture } from "./unlock";

/**
 * Detach for the unlock listeners the previous `bootAudioContext` armed. They
 * stay armed for the life of their context (see `./unlock`), and a boot always
 * builds a NEW context — so without this, every re-boot (a remount, a device
 * change, React StrictMode's double-invoke in dev) would leave behind a
 * listener set watching a context nothing plays through any more.
 */
let detachPreviousUnlock: Unsub | null = null;

export interface BootAudioContextOptions extends CreateAudioContextOptions {
  /** Gesture target the unlock fallback listens on. Defaults to `window`. */
  gestureTarget?: EventTarget | undefined;
}

/**
 * Boots the engine's audio context: constructs it (`latencyHint:
 * "interactive"` by default), resumes it, and wires the Safari unlock
 * guardrail. Worklet modules are loaded per device, by the device host's
 * `prepare` step (SS7) — not here.
 *
 * Intended to be called from inside a user-gesture handler (e.g. a "boot
 * audio" button) — the immediate `resume()` attempt then lands inside that
 * gesture's activation and the context is typically already `"running"` by
 * the time this resolves. The gesture-listener fallback stays armed
 * regardless, in case that immediate attempt doesn't stick (Safari) or
 * `bootAudioContext` is ever called ahead of any gesture at all — the next
 * real interaction on `gestureTarget` then finishes the unlock.
 *
 * Never rejects on a failed/absent resume: an unresumed context is expected
 * platform behavior pre-gesture, not a boot failure, and the returned
 * context still reflects real state via `.state`.
 *
 * Booting again replaces the previous boot's gesture listeners rather than
 * stacking a second set on top of them.
 */
export async function bootAudioContext(
  options?: BootAudioContextOptions
): Promise<BaseAudioContext> {
  const context = createAudioContext(options);
  await context.resume().catch(() => {});
  detachPreviousUnlock?.();
  detachPreviousUnlock = unlockAudioContextOnGesture(
    context,
    options?.gestureTarget ?? window,
  );
  return context;
}
