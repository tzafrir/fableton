// Every key the app answers to, in one panel.
//
// The app had a good keyboard map and no way to find it: SS10's note table,
// the arrangement's clip table, undo/redo and the QWERTY piano were all
// reachable and all invisible, documented only in source comments and a
// couple of `title` tooltips. This is the surface for them.
//
// It renders `shortcutReference()` — the same table `createAppShortcutHandler`
// matches against — so what is listed here is what the app does. The
// note-key half of the QWERTY piano is a picture rather than a list, because
// "which C does `a` play" is a question about layout, and it is drawn from
// `KEY_SEMITONES` itself so it follows the mapping and the live octave.

import { useEffect, useRef } from "react";
import { PLAY_ROWS, pianoKeyboardRows, shortcutReference, type ShortcutRow } from "../shortcuts";

export interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
  /** The QWERTY piano's live state, so the diagram says what the keys will
   *  actually play right now rather than what they play at the default. */
  octave: number;
  velocity: number;
}

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="fbl-keys">
      {keys.map((key, i) => (
        <kbd key={`${key}-${String(i)}`} className="fbl-kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Row({ row }: { row: ShortcutRow }) {
  return (
    <div className="fbl-key-row">
      <Keys keys={row.keys} />
      <span className="fbl-key-action">
        {row.action}
        {row.note !== undefined && <em className="fbl-key-note">{row.note}</em>}
      </span>
    </div>
  );
}

export function ShortcutsOverlay({ open, onClose, octave, velocity }: ShortcutsOverlayProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes it from anywhere, including from inside the panel — and it
  // is captured here rather than added to the global table, because a modal
  // owns Escape only while it is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;
  const { white, black } = pianoKeyboardRows(octave);

  return (
    <div className="fbl-modal-backdrop" onPointerDown={onClose} data-testid="shortcuts-backdrop">
      <div
        className="fbl-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-testid="shortcuts-overlay"
        // The backdrop closes on any press; the panel must not.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="fbl-modal-head">
          <h2 className="fbl-modal-title">Keyboard</h2>
          <span className="fbl-modal-sub">
            Everything below works outside a text field. The two editor maps also need their
            editor focused — click into it once.
          </span>
          <button
            ref={closeRef}
            type="button"
            className="fbl-btn fbl-btn--icon fbl-btn--ghost"
            onClick={onClose}
            aria-label="Close"
            data-testid="shortcuts-close"
          >
            ✕
          </button>
        </div>

        <div className="fbl-modal-body">
          {/* The QWERTY piano, drawn the way it sits under the hands. */}
          <section className="fbl-key-group fbl-key-group--wide">
            <h3 className="fbl-key-group-title">
              Play <span className="fbl-key-group-hint">the computer keyboard is the piano</span>
            </h3>
            <div className="fbl-qwerty" data-testid="qwerty-diagram">
              <div className="fbl-qwerty-row fbl-qwerty-row--black">
                {black.map((cap) => (
                  <span
                    key={cap.key}
                    className="fbl-cap fbl-cap--black"
                    // Black keys sit BETWEEN white ones, so each is placed by
                    // its semitone rather than laid out in sequence — which is
                    // what makes the picture read as a keyboard.
                    style={{ gridColumn: blackColumn(cap.semitone) }}
                  >
                    <span className="fbl-cap-key">{cap.key}</span>
                    <span className="fbl-cap-note">{cap.note}</span>
                  </span>
                ))}
              </div>
              <div className="fbl-qwerty-row">
                {white.map((cap) => (
                  <span key={cap.key} className="fbl-cap">
                    <span className="fbl-cap-key">{cap.key === ";" ? ";" : cap.key}</span>
                    <span className="fbl-cap-note">{cap.note}</span>
                  </span>
                ))}
              </div>
            </div>
            {/* The diagram's own two controls, beside it rather than in a
                group of their own — they answer the same question. */}
            <div className="fbl-qwerty-controls">
              <div className="fbl-qwerty-state">
                Octave <strong>{octave}</strong> · Velocity <strong>{velocity}</strong>
              </div>
              {PLAY_ROWS.map((row) => (
                <Row key={row.action} row={row} />
              ))}
            </div>
          </section>

          {shortcutReference().map((group) => (
            <section className="fbl-key-group" key={group.title}>
              <h3 className="fbl-key-group-title">
                {group.title}
                {group.hint !== undefined && (
                  <span className="fbl-key-group-hint">{group.hint}</span>
                )}
              </h3>
              {group.rows.map((row) => (
                <Row key={`${group.title}-${row.keys.join("+")}-${row.action}`} row={row} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Which of the ten white-key columns a black cap straddles.
 *
 * The white row is C D E F G A B C D E — semitones 0 2 4 5 7 9 11 12 14 16.
 * A black key at semitone `s` sits between the white keys either side of it,
 * so it is drawn spanning the gap: column `n` + a half-column offset, which
 * the stylesheet supplies as a negative margin.
 */
function blackColumn(semitone: number): number {
  const whites = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];
  let column = 1;
  for (const white of whites) {
    if (white < semitone) column += 1;
  }
  return column;
}
