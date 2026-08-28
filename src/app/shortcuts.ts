// The app shell's keyboard map — the table, the handler, and the reference
// the help panel renders, in that order and in one file on purpose.
//
// SS10: "the keyboard is a first-class client of the editor, not a bolt-on."
// That was already true INSIDE the editors, each of which registers its own
// `KeyBinding` on its own `GestureEngine` and consumes the key before it can
// leave the host (`gestureEngine.ts` calls `stopPropagation`, not just
// `preventDefault`, so a consumed editor key never reaches these window-level
// handlers at all). What was missing was the shell's own half: there was no
// way to start the transport without aiming at a button, and no way to find
// out that any of the editor maps existed.
//
// Both halves are fixed by the same table. `GLOBAL_SHORTCUTS` is matched by
// `createAppShortcutHandler` AND rendered by the help panel, so a binding
// cannot be documented without being handled or handled without being
// documented. The rows this file only DOCUMENTS — the two editors' maps, the
// QWERTY piano — carry a `guard` in shortcuts.test.ts that feeds every
// documented chord to the real binding and fails if it is not consumed.
//
// Deliberately NOT bound here: anything a browser owns (Cmd+R, Cmd+Shift+R,
// Cmd+W) and anything an editor already claims. The one bare-letter keys the
// shell takes are the digits and `?`, which the QWERTY piano does not map.

import { KEY_SEMITONES, MAX_OCTAVE, MIN_OCTAVE } from "./keyboardPiano";
import { isEditableTarget, type KeyLike } from "./keyboard";
import { noteName } from "../editor/pianoroll/keyNames";
import type { ToolMode } from "../types";

/** What the shell can be asked to do from the keyboard. */
export interface ShortcutActions {
  /** Start if stopped, stop if playing — one key, both directions. */
  playPause(): void;
  stop(): void;
  returnToStart(): void;
  record(): void;
  save(): void;
  setTool(tool: ToolMode): void;
  toggleHelp(): void;
}

export type ShortcutId =
  | "playPause"
  | "stop"
  | "returnToStart"
  | "record"
  | "save"
  | "toolSelect"
  | "toolPencil"
  | "help";

/** A chord, matched against a `KeyLike`. `primary` is Cmd on macOS and Ctrl
 *  everywhere else — the same "primary modifier" the gesture layer uses. */
interface Chord {
  readonly key: string;
  readonly primary?: boolean;
  readonly shift?: boolean;
}

export interface GlobalShortcut {
  readonly id: ShortcutId;
  readonly chord: Chord;
  /** How the chord is written in the help panel, one token per keycap. */
  readonly keys: readonly string[];
  readonly action: string;
  readonly note?: string;
  /** Space belongs to a control the user has TABBED to — see
   *  `isActivatableTarget`. Set on the bare-key rows a button also answers. */
  readonly notOnFocusedControls?: boolean;
  readonly run: (actions: ShortcutActions) => void;
}

export const GLOBAL_SHORTCUTS: readonly GlobalShortcut[] = [
  {
    id: "playPause",
    chord: { key: " " },
    keys: ["Space"],
    action: "Play / Stop",
    note: "from the playhead",
    notOnFocusedControls: true,
    run: (a) => a.playPause(),
  },
  {
    id: "returnToStart",
    chord: { key: "Home" },
    keys: ["Home"],
    action: "Move the playhead to the start",
    run: (a) => a.returnToStart(),
  },
  {
    id: "record",
    chord: { key: "F9" },
    keys: ["F9"],
    action: "Record what you play into a clip",
    note: "Stop commits the take",
    run: (a) => a.record(),
  },
  {
    id: "save",
    chord: { key: "s", primary: true },
    keys: ["Cmd/Ctrl", "S"],
    action: "Save now",
    run: (a) => a.save(),
  },
  {
    id: "toolSelect",
    chord: { key: "1" },
    keys: ["1"],
    action: "Select tool",
    run: (a) => a.setTool("select"),
  },
  {
    id: "toolPencil",
    chord: { key: "2" },
    keys: ["2"],
    action: "Pencil tool",
    run: (a) => a.setTool("pencil"),
  },
  {
    id: "help",
    chord: { key: "?" },
    keys: ["?"],
    action: "Show / hide this list",
    note: "Esc closes it",
    run: (a) => a.toggleHelp(),
  },
];

function primaryHeld(event: KeyLike): boolean {
  return event.metaKey || event.ctrlKey;
}

/**
 * A control that owns Space itself right now.
 *
 * The test is `:focus-visible`, not "is a button", and the difference is the
 * whole point. A button focused by a MOUSE CLICK keeps focus but is not
 * focus-visible, so Space after clicking `Boot audio` still starts the
 * transport — which is exactly the moment a user reaches for it, and it did
 * nothing while the rule was "never on buttons". A button reached by TAB is
 * focus-visible, and there Space must activate the button, or keyboard-only
 * navigation loses its primary activation key to the transport.
 *
 * `matches(":focus-visible")` throws in engines that do not know the
 * selector (jsdom); an unknown answer means "not claimed", which keeps the
 * transport working rather than silently swallowing the key.
 */
function isActivatableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag !== "BUTTON" && tag !== "A" && target.getAttribute("role") !== "button") return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

function matches(shortcut: GlobalShortcut, event: KeyLike): boolean {
  const { chord } = shortcut;
  if (event.altKey) return false;
  if (primaryHeld(event) !== (chord.primary ?? false)) return false;
  if (chord.shift !== undefined && event.shiftKey !== chord.shift) return false;
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
  if (shortcut.notOnFocusedControls === true && isActivatableTarget(event.target)) return false;
  return true;
}

/**
 * The window `keydown` handler for the shell's own map. Returns which
 * shortcut ran (or `"ignored"`), so a test can assert without re-deriving
 * the key logic — the same shape `createUndoRedoHandler` uses.
 *
 * Three things make it safe to run at the window level:
 *   - a key an editor consumed never arrives (the kit stops propagation),
 *     and `defaultPrevented` catches anything that only prevented;
 *   - it backs off entirely while a text field has focus;
 *   - `preventDefault` is called only for a chord it actually ran, so
 *     Cmd+S inside a rename field still belongs to the field.
 *
 * Auto-repeat is dropped: holding Space must not toggle the transport
 * thirty times a second (unlike undo, where repeat is the point).
 */
export function createAppShortcutHandler(
  actions: ShortcutActions,
): (event: KeyLike) => ShortcutId | "ignored" {
  return (event: KeyLike): ShortcutId | "ignored" => {
    if (event.repeat === true) return "ignored";
    if (event.defaultPrevented === true) return "ignored";
    if (isEditableTarget(event.target)) return "ignored";
    for (const shortcut of GLOBAL_SHORTCUTS) {
      if (!matches(shortcut, event)) continue;
      event.preventDefault();
      shortcut.run(actions);
      return shortcut.id;
    }
    return "ignored";
  };
}

// --- the reference ---------------------------------------------------------

export interface ShortcutRow {
  readonly keys: readonly string[];
  readonly action: string;
  readonly note?: string | undefined;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly hint?: string;
  readonly rows: readonly ShortcutRow[];
}

/** Handled by `createUndoRedoHandler` (src/app/keyboard.ts), not by the table
 *  above — documented here so the panel is complete. `shortcuts.test.ts`
 *  feeds these to that handler and fails if any stops working. */
export const UNDO_ROWS: readonly ShortcutRow[] = [
  { keys: ["Cmd/Ctrl", "Z"], action: "Undo" },
  { keys: ["Cmd/Ctrl", "Shift", "Z"], action: "Redo" },
  { keys: ["Cmd/Ctrl", "Y"], action: "Redo", note: "Windows / Linux convention" },
];

/** SS10's note map. Fires while the piano roll has focus — click it once. */
export const PIANO_ROLL_ROWS: readonly ShortcutRow[] = [
  { keys: ["↑", "↓"], action: "Transpose a semitone", note: "auditions at the new pitch" },
  { keys: ["Shift", "↑", "↓"], action: "Transpose an octave" },
  { keys: ["←", "→"], action: "Move by the grid" },
  { keys: ["Shift", "←", "→"], action: "Fine nudge", note: "1/64 note" },
  { keys: ["Alt", "←", "→"], action: "Shorten / lengthen by the grid" },
  { keys: ["Cmd/Ctrl", "D"], action: "Duplicate after itself" },
  { keys: ["Cmd/Ctrl", "A"], action: "Select every note in the clip" },
  { keys: ["Cmd/Ctrl", "U"], action: "Quantize starts to the grid" },
  { keys: ["0"], action: "Mute / unmute the selection" },
  { keys: ["Delete"], action: "Delete the selection" },
  { keys: ["Esc"], action: "Cancel a drag, then clear the selection" },
];

/** The arrangement's clip map, same rule: it needs the lanes focused. */
export const ARRANGEMENT_ROWS: readonly ShortcutRow[] = [
  { keys: ["←", "→"], action: "Move by the grid" },
  { keys: ["Shift", "←", "→"], action: "Fine nudge", note: "1/64 note" },
  { keys: ["↑", "↓"], action: "Move one lane" },
  { keys: ["Alt", "←", "→"], action: "Trim the right edge by the grid" },
  { keys: ["Cmd/Ctrl", "D"], action: "Duplicate after itself" },
  { keys: ["Cmd/Ctrl", "A"], action: "Select every clip" },
  { keys: ["Cmd/Ctrl", "E"], action: "Split at the playhead" },
  { keys: ["Cmd/Ctrl", "L"], action: "Loop the selected clip" },
  { keys: ["Delete"], action: "Delete the selection" },
  { keys: ["Esc"], action: "Clear the selection" },
];

/** The QWERTY piano's two control pairs. They are rendered inside the Play
 *  block, under the diagram, rather than as a group of their own: the two
 *  belong to the same question ("what will these keys play?"), and a picture
 *  with its controls beside it beats a picture and a list four columns
 *  apart. The note keys themselves get the diagram — `pianoKeyboardRows`. */
export const PLAY_ROWS: readonly ShortcutRow[] = [
  { keys: ["Z", "X"], action: "Octave down / up", note: `${String(MIN_OCTAVE)} to ${String(MAX_OCTAVE)}` },
  { keys: ["C", "V"], action: "Velocity down / up", note: "steps of 15" },
];

export function shortcutReference(): readonly ShortcutGroup[] {
  return [
    {
      title: "Transport",
      rows: GLOBAL_SHORTCUTS.filter((s) => s.id !== "toolSelect" && s.id !== "toolPencil").map(
        (s) => ({ keys: s.keys, action: s.action, note: s.note }),
      ),
    },
    {
      title: "Edit",
      rows: [
        ...UNDO_ROWS,
        ...GLOBAL_SHORTCUTS.filter((s) => s.id === "toolSelect" || s.id === "toolPencil").map(
          (s) => ({ keys: s.keys, action: s.action, note: s.note }),
        ),
      ],
    },
    { title: "Piano roll", hint: "while the note grid has focus", rows: PIANO_ROLL_ROWS },
    { title: "Arrangement", hint: "while the lanes have focus", rows: ARRANGEMENT_ROWS },
  ];
}

// --- the QWERTY piano, as a picture ----------------------------------------

export interface PianoKeyCap {
  /** The computer key, as it is printed on the keycap. */
  readonly key: string;
  /** Semitones above the current octave's C. */
  readonly semitone: number;
  /** The note it plays right now, e.g. "C3" — follows the octave. */
  readonly note: string;
  readonly black: boolean;
}

/**
 * The QWERTY mapping laid out the way it sits under the hands: the home row
 * is the white keys, the row above holds the black ones, and each cap is
 * labelled with the note it plays AT THE CURRENT OCTAVE. Derived from
 * `KEY_SEMITONES` itself, so the picture cannot drift from the mapping.
 */
export function pianoKeyboardRows(octave: number): {
  white: readonly PianoKeyCap[];
  black: readonly PianoKeyCap[];
} {
  const caps: PianoKeyCap[] = Object.entries(KEY_SEMITONES).map(([key, semitone]) => ({
    key,
    semitone,
    note: noteName(60 + (octave - 3) * 12 + semitone),
    black: BLACK_SEMITONES.has(((semitone % 12) + 12) % 12),
  }));
  caps.sort((a, b) => a.semitone - b.semitone);
  return {
    white: caps.filter((cap) => !cap.black),
    black: caps.filter((cap) => cap.black),
  };
}

const BLACK_SEMITONES = new Set([1, 3, 6, 8, 10]);
