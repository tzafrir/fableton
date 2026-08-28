// The shell's keyboard map, and — the point of this file — the guarantee
// that the help panel cannot lie.
//
// `shortcutReference()` renders four groups the shell does not itself
// handle: undo/redo (src/app/keyboard.ts), the piano roll's map, the
// arrangement's map, and the QWERTY piano's control keys. Documentation that
// drifts from the code is worse than none, so every documented chord below
// is fed to the REAL binding and has to be consumed.

import { describe, expect, it, vi } from "vitest";
import type { KeyInput, Modifiers } from "../types/gesture";
import { createUndoRedoHandler, type KeyLike } from "./keyboard";
import { createKeyboardPiano } from "./keyboardPiano";
import {
  ARRANGEMENT_ROWS,
  GLOBAL_SHORTCUTS,
  PIANO_ROLL_ROWS,
  PLAY_ROWS,
  UNDO_ROWS,
  createAppShortcutHandler,
  pianoKeyboardRows,
  shortcutReference,
  type ShortcutActions,
  type ShortcutRow,
} from "./shortcuts";
import { createHarness as createRollHarness } from "../editor/pianoroll/testing/harness";
import {
  BAR,
  CLIP_1,
  CLIP_2,
  createHarness as createArrHarness,
} from "../editor/arrangement/testing/harness";

function actions(): { spies: Record<keyof ShortcutActions, ReturnType<typeof vi.fn>>; actions: ShortcutActions } {
  const spies = {
    playPause: vi.fn(),
    stop: vi.fn(),
    returnToStart: vi.fn(),
    record: vi.fn(),
    save: vi.fn(),
    setTool: vi.fn(),
    toggleHelp: vi.fn(),
  };
  return { spies, actions: spies as unknown as ShortcutActions };
}

function press(over: Partial<KeyLike> & { key: string }): KeyLike & { prevented: boolean } {
  const event = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    ...over,
  };
  return event as KeyLike & { prevented: boolean };
}

describe("the shell's global map", () => {
  it("Space toggles the transport and swallows the key", () => {
    const { spies, actions: a } = actions();
    const handle = createAppShortcutHandler(a);
    const event = press({ key: " " });
    expect(handle(event)).toBe("playPause");
    expect(spies.playPause).toHaveBeenCalledTimes(1);
    // Without this the page scrolls under the editor on every play.
    expect(event.prevented).toBe(true);
  });

  it("runs the rest of the table", () => {
    const { spies, actions: a } = actions();
    const handle = createAppShortcutHandler(a);
    expect(handle(press({ key: "Home" }))).toBe("returnToStart");
    expect(handle(press({ key: "F9" }))).toBe("record");
    expect(handle(press({ key: "s", metaKey: true }))).toBe("save");
    expect(handle(press({ key: "s", ctrlKey: true }))).toBe("save");
    expect(handle(press({ key: "1" }))).toBe("toolSelect");
    expect(handle(press({ key: "2" }))).toBe("toolPencil");
    expect(handle(press({ key: "?" }))).toBe("help");
    expect(spies.setTool.mock.calls).toEqual([["select"], ["pencil"]]);
    expect(spies.toggleHelp).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way of typing", () => {
    const { spies, actions: a } = actions();
    const handle = createAppShortcutHandler(a);
    const input = document.createElement("input");
    expect(handle(press({ key: " ", target: input }))).toBe("ignored");
    // Cmd+S in a rename field belongs to the field, not to the project.
    const saveInField = press({ key: "s", metaKey: true, target: input });
    expect(handle(saveInField)).toBe("ignored");
    expect(saveInField.prevented).toBe(false);
    expect(spies.playPause).not.toHaveBeenCalled();
  });

  it("still plays after a button was CLICKED, but yields Space to one that was tabbed to", () => {
    const { spies, actions: a } = actions();
    const handle = createAppShortcutHandler(a);

    // Clicking `Boot audio` leaves it focused but not focus-visible. This is
    // the moment a user reaches for Space, so it has to work.
    const clicked = document.createElement("button");
    clicked.matches = () => false;
    expect(handle(press({ key: " ", target: clicked }))).toBe("playPause");
    expect(spies.playPause).toHaveBeenCalledTimes(1);

    // Tabbed to: Space is that button's own activation key.
    const tabbed = document.createElement("button");
    tabbed.matches = () => true;
    expect(handle(press({ key: " ", target: tabbed }))).toBe("ignored");
    expect(spies.playPause).toHaveBeenCalledTimes(1);

    // Only the rows that say so yield; a digit is not a button's key.
    expect(handle(press({ key: "1", target: tabbed }))).toBe("toolSelect");
  });

  it("ignores a key something upstream already consumed", () => {
    const { spies, actions: a } = actions();
    const handle = createAppShortcutHandler(a);
    expect(handle(press({ key: " ", defaultPrevented: true }))).toBe("ignored");
    expect(spies.playPause).not.toHaveBeenCalled();
  });

  it("drops auto-repeat: holding Space must not machine-gun the transport", () => {
    const { spies, actions: a } = actions();
    const handle = createAppShortcutHandler(a);
    expect(handle(press({ key: " " }))).toBe("playPause");
    expect(handle(press({ key: " ", repeat: true }))).toBe("ignored");
    expect(spies.playPause).toHaveBeenCalledTimes(1);
  });

  it("does not shadow an editor's Alt bindings", () => {
    const { actions: a } = actions();
    const handle = createAppShortcutHandler(a);
    expect(handle(press({ key: "1", altKey: true }))).toBe("ignored");
  });

  it("never claims a key the QWERTY piano plays", () => {
    const piano = createKeyboardPiano({ sink: () => undefined });
    for (const shortcut of GLOBAL_SHORTCUTS) {
      if (shortcut.chord.primary === true) continue; // modified: no conflict
      expect(piano.keyDown(shortcut.chord.key), `"${shortcut.chord.key}" is a piano key`).toBe(
        "ignored",
      );
    }
  });
});

// --- the reference is the table ------------------------------------------

/** Display tokens -> the key presses they stand for. "←", "→" expand to a
 *  press each, so a documented row is checked in both directions. */
function pressesFor(row: ShortcutRow): { key: string; mods: Partial<Modifiers> }[] {
  const mods: Partial<Modifiers> = {};
  const keys: string[] = [];
  for (const token of row.keys) {
    switch (token) {
      case "Cmd/Ctrl":
        mods.primary = true;
        mods.meta = true;
        break;
      case "Shift":
        mods.shift = true;
        break;
      case "Alt":
        mods.alt = true;
        break;
      case "←":
        keys.push("ArrowLeft");
        break;
      case "→":
        keys.push("ArrowRight");
        break;
      case "↑":
        keys.push("ArrowUp");
        break;
      case "↓":
        keys.push("ArrowDown");
        break;
      case "Esc":
        keys.push("Escape");
        break;
      default:
        keys.push(token);
    }
  }
  return keys.map((key) => ({ key, mods }));
}

const NONE: Modifiers = { shift: false, alt: false, ctrl: false, meta: false, primary: false };
const keyInput = (key: string, mods: Partial<Modifiers>): KeyInput => ({
  key,
  modifiers: { ...NONE, ...mods },
});

describe("shortcutReference", () => {
  it("lists every shortcut the shell handles, and nothing it does not", () => {
    const listed = shortcutReference().flatMap((group) => group.rows.map((r) => r.action));
    for (const shortcut of GLOBAL_SHORTCUTS) {
      expect(listed, `${shortcut.id} is handled but not documented`).toContain(shortcut.action);
    }
    // Four groups, none of them empty — an empty group renders as a heading
    // over nothing. (The QWERTY piano is the fifth block in the panel, but
    // it is a diagram plus `PLAY_ROWS`, not a group of rows.)
    const groups = shortcutReference();
    expect(groups).toHaveLength(4);
    for (const group of groups) expect(group.rows.length).toBeGreaterThan(0);
  });

  it("documents undo/redo exactly as `createUndoRedoHandler` implements it", () => {
    const store = { undo: vi.fn(), redo: vi.fn() } as unknown as Parameters<
      typeof createUndoRedoHandler
    >[0];
    const handle = createUndoRedoHandler(store);
    for (const row of UNDO_ROWS) {
      for (const { key, mods } of pressesFor(row)) {
        const outcome = handle(
          press({
            key,
            metaKey: mods.primary === true,
            shiftKey: mods.shift === true,
          }),
        );
        expect(outcome, `${row.keys.join("+")} is documented but not handled`).not.toBe("ignored");
      }
    }
  });

  it("documents the piano roll's map exactly as the binding implements it", () => {
    for (const row of PIANO_ROLL_ROWS) {
      for (const { key, mods } of pressesFor(row)) {
        // A fresh harness per press: several rows MUTATE the selection
        // (Delete clears it, Esc clears it), and a row is only consumed when
        // there is something selected.
        const h = createRollHarness();
        h.ctx.selection.set(h.ctx.notes().map((note) => note.id));
        expect(h.key(key, mods), `piano roll: ${row.keys.join("+")} (${key})`).toBe(true);
      }
    }
  });

  it("documents the arrangement's map exactly as the binding implements it", () => {
    for (const row of ARRANGEMENT_ROWS) {
      for (const { key, mods } of pressesFor(row)) {
        const h = createArrHarness();
        h.selection.set([CLIP_1, CLIP_2]);
        // Split needs a playhead that actually crosses the selection — at
        // tick 0 it sits on CLIP_1's own start, which is not a split point.
        h.playhead = BAR / 2;
        expect(h.engine.keyDown(keyInput(key, mods)), `arrangement: ${row.keys.join("+")} (${key})`)
          .toBe(true);
      }
    }
  });

  it("documents the QWERTY piano's control keys exactly as the piano implements them", () => {
    for (const row of PLAY_ROWS) {
      for (const { key } of pressesFor(row)) {
        const piano = createKeyboardPiano({ sink: () => undefined });
        expect(piano.keyDown(key.toLowerCase()), `piano control: ${key}`).toBe("control");
      }
    }
  });
});

describe("pianoKeyboardRows", () => {
  it("lays the mapping out as white and black rows, in pitch order", () => {
    const { white, black } = pianoKeyboardRows(3);
    expect(white.map((cap) => cap.key)).toEqual(["a", "s", "d", "f", "g", "h", "j", "k", "l", ";"]);
    expect(black.map((cap) => cap.key)).toEqual(["w", "e", "t", "y", "u", "o", "p"]);
    expect(white[0]?.note).toBe("C3");
    expect(white[7]?.note).toBe("C4");
    expect(black[0]?.note).toBe("C#3");
  });

  it("follows the octave, so the picture always says what the keys will play", () => {
    expect(pianoKeyboardRows(4).white[0]?.note).toBe("C4");
    expect(pianoKeyboardRows(2).white[0]?.note).toBe("C2");
  });
});
