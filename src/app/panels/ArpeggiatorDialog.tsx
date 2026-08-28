// The arpeggiator's settings, as a small modal.
//
// It is a GENERATOR, not a live note effect (src/state/arpeggio.ts says why),
// so the interaction is "choose, apply, look at what you got" rather than a
// device panel you leave running. That shape is what the dialog is for: the
// four decisions in one place, one button, and the result on screen in the
// roll behind it — one Undo away if it is wrong.
//
// The settings persist for the session (the shell holds them), because the
// second thing anyone does with an arpeggiator is run it again on the next
// chord with the same rate.

import { useEffect, useRef } from "react";
import type { ArpMode, ArpOptions, Ticks } from "../../types";

export interface ArpeggiatorDialogProps {
  open: boolean;
  onClose: () => void;
  options: ArpOptions;
  onChange: (options: ArpOptions) => void;
  /** Runs it. The shell owns the clip and the selection. */
  onApply: () => void;
  /** Notes currently selected — the dialog says what it will act on, and
   *  refuses to apply to nothing. */
  selectionCount: number;
}

/** Rates offered, coarse to fine. Ticks at PPQ 960. */
const RATES: readonly { label: string; ticks: Ticks }[] = [
  { label: "1/4", ticks: 960 },
  { label: "1/4T", ticks: 640 },
  { label: "1/8", ticks: 480 },
  { label: "1/8T", ticks: 320 },
  { label: "1/16", ticks: 240 },
  { label: "1/16T", ticks: 160 },
  { label: "1/32", ticks: 120 },
];

const MODE_LABELS: Readonly<Record<ArpMode, string>> = {
  up: "Up",
  down: "Down",
  upDown: "Up / Down",
  downUp: "Down / Up",
  asPlayed: "As played",
  random: "Random",
};

const MODE_ORDER: readonly ArpMode[] = ["up", "down", "upDown", "downUp", "asPlayed", "random"];

export function ArpeggiatorDialog({
  open,
  onClose,
  options,
  onChange,
  onApply,
  selectionCount,
}: ArpeggiatorDialogProps) {
  const applyRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes, Enter applies — captured while open only, the same rule
  // `ShortcutsOverlay` follows: a modal owns those keys while it is up.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Enter" && selectionCount > 0) {
        event.preventDefault();
        event.stopPropagation();
        onApply();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    applyRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, onApply, selectionCount]);

  if (!open) return null;

  return (
    <div className="fbl-modal-backdrop" onPointerDown={onClose} data-testid="arp-backdrop">
      <div
        className="fbl-modal fbl-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Arpeggiate"
        data-testid="arp-dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="fbl-modal-head">
          <h2 className="fbl-modal-title">Arpeggiate</h2>
          <span className="fbl-modal-sub">
            Rewrites the selected notes as an arpeggio over the same span. One Undo brings the
            chord back.
          </span>
          <button
            type="button"
            className="fbl-btn fbl-btn--icon fbl-btn--ghost"
            onClick={onClose}
            aria-label="Close"
            data-testid="arp-close"
          >
            ✕
          </button>
        </div>

        <div className="fbl-modal-body fbl-arp-body">
          <label className="fbl-arp-row">
            <span className="fbl-arp-label">Rate</span>
            <select
              className="fbl-field fbl-field--sm"
              value={String(options.step)}
              data-testid="arp-rate"
              onChange={(event) => onChange({ ...options, step: Number(event.target.value) })}
            >
              {RATES.map((rate) => (
                <option key={rate.label} value={rate.ticks}>
                  {rate.label}
                </option>
              ))}
            </select>
          </label>

          <label className="fbl-arp-row">
            <span className="fbl-arp-label">Order</span>
            <select
              className="fbl-field fbl-field--sm"
              value={options.mode}
              data-testid="arp-mode"
              onChange={(event) =>
                onChange({ ...options, mode: event.target.value as ArpMode })
              }
            >
              {MODE_ORDER.map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>

          <label className="fbl-arp-row">
            <span className="fbl-arp-label">Octaves</span>
            <input
              type="number"
              className="fbl-field fbl-field--sm fbl-field--num"
              min={1}
              max={4}
              step={1}
              value={options.octaves}
              data-testid="arp-octaves"
              onChange={(event) =>
                onChange({
                  ...options,
                  octaves: Math.max(1, Math.min(4, Math.round(Number(event.target.value) || 1))),
                })
              }
            />
          </label>

          <label className="fbl-arp-row">
            <span className="fbl-arp-label">Gate</span>
            <input
              type="number"
              className="fbl-field fbl-field--sm fbl-field--num"
              min={5}
              max={200}
              step={5}
              value={options.gate}
              data-testid="arp-gate"
              onChange={(event) =>
                onChange({
                  ...options,
                  gate: Math.max(5, Math.min(200, Math.round(Number(event.target.value) || 5))),
                })
              }
            />
            <span className="fbl-arp-unit">% of step</span>
          </label>
        </div>

        <div className="fbl-modal-foot">
          <span className="fbl-arp-count" data-testid="arp-selection">
            {selectionCount === 0
              ? "Select notes in the piano roll first"
              : `${String(selectionCount)} note${selectionCount === 1 ? "" : "s"} selected`}
          </span>
          <button
            ref={applyRef}
            type="button"
            className="fbl-btn"
            data-on={selectionCount > 0}
            disabled={selectionCount === 0}
            onClick={onApply}
            data-testid="arp-apply"
          >
            Arpeggiate
          </button>
        </div>
      </div>
    </div>
  );
}
