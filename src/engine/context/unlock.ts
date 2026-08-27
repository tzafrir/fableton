// SS12 guardrail: "resume the context on first user gesture (Safari)".
//
// `new AudioContext()` inside a click handler is not always enough — Safari
// in particular can still hand back a `"suspended"` context, and only
// actually unlocks the audio hardware from inside the synchronous call
// stack of a real user-gesture *event* (click/keydown/touch), not just "a
// promise chain that started during one". This wires a listener across the
// common gesture event types so whichever fires first drives the `resume()`
// call.
//
// The listeners stay armed for the life of the context — they are removed
// only through the returned `Unsub`. A resume that rejects, or that resolves
// with the context still `"suspended"` (exactly the Safari behaviour above),
// leaves the app silent, and a listener that had already removed itself could
// never retry: recovery would need a page reload. The same reasoning covers a
// context that is already running, or that the UA suspends later (iOS
// interruption, backgrounded tab) — the next gesture unlocks it again. The
// standing cost is one state read per gesture, and no `resume()` call at all
// while the context is running.
//
// The context parameter is a narrow structural type (not the full DOM
// `AudioContext`) so this stays trivially unit-testable headless — a real
// `AudioContext` satisfies it structurally, no casting needed at call sites.

import type { Unsub } from "../../types";

/** The only surface this module needs from an audio context. */
export interface ResumableAudioContext {
  readonly state: AudioContextState;
  resume(): Promise<void>;
}

const GESTURE_EVENT_TYPES = ["pointerdown", "keydown", "touchend"] as const;

/**
 * Attaches unlock listeners to `target` (default: `window`) that call
 * `context.resume()` on a gesture while the context is not running.
 *
 * A gesture arriving while the context is already running costs a state read
 * and nothing else — no `resume()` call — and the listeners stay in place so a
 * later suspension can still be recovered from. At most one resume attempt is
 * ever in flight. Safe to call more than once for the same context: each call
 * manages its own listener set. The returned {@link Unsub} is the only thing
 * that detaches them, and the caller is expected to hold it for as long as the
 * context lives (component unmount, context close, a re-boot replacing it).
 */
export function unlockAudioContextOnGesture(
  context: ResumableAudioContext,
  target: EventTarget = window
): Unsub {
  let detached = false;
  /** True while a `resume()` attempt is outstanding — one at a time. */
  let resuming = false;

  const detach = (): void => {
    if (detached) return;
    detached = true;
    for (const type of GESTURE_EVENT_TYPES) {
      target.removeEventListener(type, handleGesture);
    }
  };

  function handleGesture(): void {
    if (detached || resuming) return;
    // Already running: nothing to do, but stay armed in case the UA suspends
    // this context later.
    if (context.state === "running") return;
    resuming = true;
    void (async () => {
      try {
        await context.resume();
      } catch {
        // Best-effort: a rejected resume (e.g. the context was closed) just
        // leaves the listeners armed for the next gesture.
      }
      resuming = false;
      // Deliberately no detach on success: a context that unlocked once can
      // be suspended again by the UA, and only a gesture can unlock it. See
      // the header — this listener set outlives the first unlock.
    })();
  }

  for (const type of GESTURE_EVENT_TYPES) {
    target.addEventListener(type, handleGesture);
  }

  return detach;
}
