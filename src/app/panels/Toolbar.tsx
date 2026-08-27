// SS18-M1 chrome: transport (play/stop, carried over from M0), global
// undo/redo, and the save/export/import UI over the persistence package.
// Plain DOM controls — this is exactly the "bounded by count" UI SS15 keeps
// in React, never canvas.

import { useCallback, useRef, type ChangeEvent } from "react";
import type { AutosaveState, GridSettings, ToolMode, TransportState } from "../../types";
import { SongControls, type SongControlsProps } from "./SongControls";

export interface ToolbarProps {
  /** SS8/SS13 song-level controls (name, tempo, time signature, loop). The
   *  commands behind them shipped in M1; this is their control surface. */
  song: SongControlsProps;

  audioStatus: string;
  audioReady: boolean;
  audioBooting: boolean;
  onBoot: () => void;

  transportState: TransportState;
  onPlay: () => void;
  onStop: () => void;

  canUndo: boolean;
  undoLabel: string | undefined;
  onUndo: () => void;
  canRedo: boolean;
  redoLabel: string | undefined;
  onRedo: () => void;

  /** SS4/SS11: true while any param is `overridden`; the pill lights and
   *  clicking it restores every one of them to `automated`. */
  hasOverrides: boolean;
  onReenableAutomation: () => void;

  /** SS10's two piano-roll tools. Without a control here, `pencil` — and
   *  therefore drag-to-create notes — is unreachable in the shipped app. */
  tool: ToolMode;
  onToolChange: (tool: ToolMode) => void;

  /** SS10 "Snapping": "Grid is adaptive to zoom (as in Live) with a
   *  fixed-grid override menu and a triplet toggle." Grid settings are
   *  ephemeral UI state (SS13); the shell owns them and pushes them into both
   *  editors. */
  gridSettings: GridSettings;
  onGridChange: (settings: Partial<GridSettings>) => void;

  autosaveState: AutosaveState;
  autosaveError: string | null;
  /** False when the storage backend reports `available: false` (SS13: "the
   *  app must still run, just without autosave"). The status pill must not
   *  claim "Saved" for a document nothing will ever persist. */
  autosaveAvailable?: boolean | undefined;
  onSaveNow: () => void;
  onNewProject: () => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  /** SS12 export: render the document offline and download a .wav. */
  onExportWav: () => void;
  exportingWav: boolean;

  /** SS10 clip loop: toggles the loop brace over the arrangement selection.
   *  The verb shipped in M1 as `Cmd/Ctrl+L`; without a button, looping a clip
   *  was a shortcut you had to already know about. */
  canLoopClip: boolean;
  onLoopClip: () => void;

  /** Surfaced import/decode errors and load warnings — a one-line status
   *  string, or `null` when there is nothing to report. */
  statusMessage?: string | null | undefined;
}

/** The override menu's entries: adaptive, the fixed divisions a composer
 *  actually reaches for, and "off" (SS10's three `GridSettings.mode`s). */
const GRID_CHOICES: readonly { value: string; label: string; settings: Partial<GridSettings> }[] = [
  { value: "adaptive", label: "Grid: Adaptive", settings: { mode: "adaptive" } },
  { value: "4", label: "Grid: 1/4", settings: { mode: "fixed", denominator: 4 } },
  { value: "8", label: "Grid: 1/8", settings: { mode: "fixed", denominator: 8 } },
  { value: "16", label: "Grid: 1/16", settings: { mode: "fixed", denominator: 16 } },
  { value: "32", label: "Grid: 1/32", settings: { mode: "fixed", denominator: 32 } },
  { value: "off", label: "Grid: Off", settings: { mode: "off" } },
];

export function gridChoiceValue(settings: GridSettings): string {
  if (settings.mode === "adaptive") return "adaptive";
  if (settings.mode === "off") return "off";
  return String(settings.denominator);
}

function autosaveLabel(state: AutosaveState, available: boolean): string {
  if (!available) return "Not saved";
  switch (state) {
    case "idle":
      return "Saved";
    case "pending":
      return "Edited";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return "Save failed";
  }
}

export function Toolbar({
  song,
  audioStatus,
  audioReady,
  audioBooting,
  onBoot,
  transportState,
  onPlay,
  onStop,
  canUndo,
  undoLabel,
  onUndo,
  canRedo,
  redoLabel,
  onRedo,
  tool,
  onToolChange,
  hasOverrides,
  onReenableAutomation,
  gridSettings,
  onGridChange,
  canLoopClip,
  onLoopClip,
  autosaveState,
  autosaveError,
  autosaveAvailable = true,
  onSaveNow,
  onNewProject,
  onExport,
  onImportFile,
  onExportWav,
  exportingWav,
  statusMessage,
}: ToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleGridChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const choice = GRID_CHOICES.find((entry) => entry.value === event.target.value);
      if (choice !== undefined) onGridChange(choice.settings);
    },
    [onGridChange],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset immediately so choosing the SAME file twice in a row still
      // fires `onChange` the second time.
      event.target.value = "";
      if (file !== undefined) onImportFile(file);
    },
    [onImportFile],
  );

  return (
    // Inline layout, matching how the rest of the shell styles itself: the
    // app ships no stylesheet, so without this the status readouts render as
    // one run-on string ("Savedready (worklet loaded...)playing").
    <div
      className="fbl-toolbar"
      data-testid="toolbar"
      role="toolbar"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "4px 8px",
      }}
    >
      <SongControls {...song} />

      <button type="button" onClick={onBoot} disabled={audioReady || audioBooting}>
        Boot audio
      </button>
      <button type="button" onClick={onPlay} disabled={!audioReady || transportState === "playing"}>
        Play
      </button>
      <button type="button" onClick={onStop} disabled={!audioReady || transportState === "stopped"}>
        Stop
      </button>

      <button
        type="button"
        data-testid="reenable-automation"
        title="Re-enable automation (SS4): restore every overridden param to its lane"
        onClick={onReenableAutomation}
        disabled={!hasOverrides}
        style={{
          background: hasOverrides ? "#c58f00" : undefined,
          color: hasOverrides ? "#000" : undefined,
        }}
      >
        Re-enable
      </button>

      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title={undoLabel !== undefined ? `Undo ${undoLabel}` : undefined}
        data-testid="undo-button"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        title={redoLabel !== undefined ? `Redo ${redoLabel}` : undefined}
        data-testid="redo-button"
      >
        Redo
      </button>

      <span
        className="fbl-toolbar-tools"
        role="radiogroup"
        aria-label="Piano roll tool"
        style={{ display: "inline-flex", gap: 4 }}
      >
        <button
          type="button"
          role="radio"
          aria-checked={tool === "select"}
          onClick={() => onToolChange("select")}
          title="Select tool — marquee and drag"
          data-testid="tool-select-button"
          style={{ fontWeight: tool === "select" ? 700 : 400 }}
        >
          Select
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={tool === "pencil"}
          onClick={() => onToolChange("pencil")}
          title="Pencil tool — drag on empty grid to create notes"
          data-testid="tool-pencil-button"
          style={{ fontWeight: tool === "pencil" ? 700 : 400 }}
        >
          Pencil
        </button>
      </span>

      <button
        type="button"
        data-testid="loop-clip-button"
        onClick={onLoopClip}
        disabled={!canLoopClip}
        title="Loop the selected clip(s) — drag the clip's right edge to unroll repeats (Cmd/Ctrl+L)"
      >
        Loop Clip
      </button>

      <label className="fbl-toolbar-grid" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Grid
        </span>
        <select value={gridChoiceValue(gridSettings)} onChange={handleGridChange} data-testid="grid-select">
          {GRID_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={gridSettings.triplet}
          onChange={(event) => onGridChange({ triplet: event.target.checked })}
          data-testid="grid-triplet-toggle"
        />
        Triplet
      </label>

      <button type="button" onClick={onNewProject}>
        New
      </button>
      <button type="button" onClick={onSaveNow} data-testid="save-button">
        Save
      </button>
      <button type="button" onClick={onExport} data-testid="export-button">
        Export…
      </button>
      <button type="button" onClick={handleImportClick} data-testid="import-button">
        Import…
      </button>
      <button
        type="button"
        onClick={onExportWav}
        disabled={exportingWav}
        data-testid="export-wav-button"
        title="Render the project offline (SS12) and download a 16-bit WAV"
      >
        {exportingWav ? "Rendering…" : "Export WAV"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        data-testid="import-file-input"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      <span
        data-testid="autosave-status"
        title={
          autosaveError ??
          (autosaveAvailable ? undefined : "This browser has no local project storage (OPFS).")
        }
      >
        {autosaveLabel(autosaveState, autosaveAvailable)}
      </span>
      <span data-testid="audio-status">{audioStatus}</span>
      <span data-testid="transport-state">{transportState}</span>
      {statusMessage !== undefined && statusMessage !== null && (
        <span data-testid="toolbar-status-message">{statusMessage}</span>
      )}
    </div>
  );
}
