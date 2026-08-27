// SS18-M1 chrome: transport (play/stop, carried over from M0), global
// undo/redo, and the save/export/import UI over the persistence package.
// Plain DOM controls — this is exactly the "bounded by count" UI SS15 keeps
// in React, never canvas.

import { useCallback, useRef, type ChangeEvent } from "react";
import type { AutosaveState, TransportState } from "../../types";

export interface ToolbarProps {
  projectName: string;

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

  autosaveState: AutosaveState;
  autosaveError: string | null;
  onSaveNow: () => void;
  onNewProject: () => void;
  onExport: () => void;
  onImportFile: (file: File) => void;

  /** Surfaced import/decode errors and load warnings — a one-line status
   *  string, or `null` when there is nothing to report. */
  statusMessage?: string | null | undefined;
}

function autosaveLabel(state: AutosaveState): string {
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
  projectName,
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
  autosaveState,
  autosaveError,
  onSaveNow,
  onNewProject,
  onExport,
  onImportFile,
  statusMessage,
}: ToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

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
      <span className="fbl-toolbar-project" data-testid="project-name">
        {projectName}
      </span>

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
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        data-testid="import-file-input"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      <span data-testid="autosave-status" title={autosaveError ?? undefined}>
        {autosaveLabel(autosaveState)}
      </span>
      <span data-testid="audio-status">{audioStatus}</span>
      <span data-testid="transport-state">{transportState}</span>
      {statusMessage !== undefined && statusMessage !== null && (
        <span data-testid="toolbar-status-message">{statusMessage}</span>
      )}
    </div>
  );
}
