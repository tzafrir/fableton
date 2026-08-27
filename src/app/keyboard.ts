// SS13/SS18-M1 — "global undo/redo (Cmd/Ctrl+Z / Shift+Z) through the command
// bus." A plain, headless-testable handler (SS15: "every input method takes a
// PLAIN object so FSMs are unit-testable headless" — the same discipline the
// editor kit's gesture engine uses, applied to the app shell's one global
// binding) so the window-level `keydown` listener in `App.tsx` is a one-line
// wrapper around this.
//
// Deliberately narrow: undo/redo is the ONLY global shortcut the app shell
// owns. Every editor-local key map (SS10's piano-roll table, the
// arrangement's) is registered on its own `GestureEngine` and only fires
// while that editor's host element has focus — this handler runs at the
// window level and must therefore stay out of the way of ordinary typing
// (a project-name field, a clip-rename input) and out of the way of an
// editor's own binding of the same physical key, which is why it also
// backs off while any element with a text cursor is focused.

import type { DocumentStore } from "../types";

/** The minimal shape a real `KeyboardEvent` and a synthetic test object both
 *  satisfy — the same "plain object" discipline `types/gesture.ts` uses. */
export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
  repeat?: boolean | undefined;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True while the event's target is somewhere the user is typing text — a
 *  form field, or any element with `contenteditable`. Canvas editor hosts are
 *  plain `HTMLElement`s outside this set, so their own key bindings (which
 *  run on the host element, not the window) are unaffected either way. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (EDITABLE_TAGS.has(target.tagName)) return true;
  // jsdom does not implement the `contenteditable` behavior behind
  // `isContentEditable` (it is present on the type but not wired up), so the
  // attribute is the portable check; a real browser keeps `isContentEditable`
  // in sync with it, so this covers both.
  return target.isContentEditable || target.getAttribute("contenteditable") === "true";
}

/** Platform "primary" modifier — `metaKey` on macOS, `ctrlKey` elsewhere,
 *  matching `Modifiers.primary` in `types/gesture.ts`. Undo/redo has no
 *  viewport to ask, so it goes by which modifier the event actually carries;
 *  a synthetic test event sets whichever one its platform would. */
function primaryHeld(event: KeyLike): boolean {
  return event.metaKey || event.ctrlKey;
}

export type UndoRedoOutcome = "undo" | "redo" | "ignored";

/**
 * Builds the window `keydown` handler. Returns what it did, so the caller
 * (and a test) can assert without re-deriving the key logic:
 *   - `Cmd/Ctrl+Z`        -> undo
 *   - `Cmd/Ctrl+Shift+Z`  -> redo (SS18-M1's "Shift+Z")
 *   - `Cmd/Ctrl+Y`        -> redo (the Windows/Linux convention; additive,
 *                            never required, so `Shift+Z` keeps working
 *                            everywhere the spec names it)
 * `preventDefault()` is called only when the key was actually consumed, so a
 * plain `Ctrl+Z` typed into a text field still reaches the field (browsers
 * also run their native undo there, which is the field's job, not ours).
 *
 * Auto-repeat is HONOURED (`event.repeat` is not a reason to bail): holding
 * `Cmd/Ctrl+Z` walks back through the history one entry per repeat, which is
 * how a user actually unwinds a long edit chain. Each dispatch is an
 * independent `store.undo()`, so repeats need no special handling.
 */
export function createUndoRedoHandler(store: DocumentStore): (event: KeyLike) => UndoRedoOutcome {
  return (event: KeyLike): UndoRedoOutcome => {
    if (!primaryHeld(event)) return "ignored";
    if (isEditableTarget(event.target)) return "ignored";

    const key = event.key.toLowerCase();
    if (key === "z" && event.shiftKey) {
      event.preventDefault();
      store.redo();
      return "redo";
    }
    if (key === "z") {
      event.preventDefault();
      store.undo();
      return "undo";
    }
    if (key === "y") {
      event.preventDefault();
      store.redo();
      return "redo";
    }
    return "ignored";
  };
}
