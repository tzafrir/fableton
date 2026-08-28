// SS18-M1 chrome: transport (play/stop, carried over from M0), global
// undo/redo, and the save/export/import UI over the persistence package.
// Plain DOM controls — this is exactly the "bounded by count" UI SS15 keeps
// in React, never canvas.

import { useCallback, useRef, type ChangeEvent, type ReactNode } from "react";
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
  /** SS12 record: capture what the computer keyboard plays into a clip.
   *  Stopping is what commits the take, so there is no separate button. */
  recording: boolean;
  onRecord: () => void;
  /** The QWERTY keyboard's current octave and velocity (z/x and c/v), shown
   *  because nothing else on screen says which C the `a` key is. */
  keyboardOctave: number;
  keyboardVelocity: number;

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

  /** Opens the keyboard reference (also bound to `?`). The app's key map was
   *  entirely undiscoverable before it had a control. */
  onShowShortcuts?: (() => void) | undefined;
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

/** Which dot the autosave pill lights. The dot is a `::before` in the
 *  stylesheet, never a character, so the pill's text stays exactly the
 *  status word — "Saved" has to READ as Saved to a screen reader and to the
 *  tests that pin this contract. */
function autosaveTone(state: AutosaveState, available: boolean): string {
  if (!available) return "off";
  if (state === "error") return "error";
  if (state === "saving" || state === "pending") return "busy";
  return "ok";
}

function audioTone(status: string, ready: boolean): string {
  if (status.startsWith("error") || status.startsWith("failed")) return "error";
  return ready ? "ok" : "off";
}

/** A labelled cluster of controls. The toolbar carries thirty-odd verbs; a
 *  flat row of them is a wall, so related verbs sit under one small caps
 *  label and neighbouring clusters are told apart by a hairline. */
function Group({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <span className="fbl-tb-group">
      {label !== undefined && <span className="fbl-tb-label">{label}</span>}
      {children}
    </span>
  );
}

function Sep() {
  return <span className="fbl-tb-sep" aria-hidden="true" />;
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
  recording,
  onRecord,
  keyboardOctave,
  keyboardVelocity,
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
  onShowShortcuts,
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
    <div className="fbl-toolbar" data-testid="toolbar" role="toolbar">
      <h1 className="fbl-brand">Fableton</h1>

      <SongControls {...song} />

      <Sep />

      {/* Transport. The three verbs a hand reaches for without looking, so
          they are glyphs at a bigger hit size than anything else here — and
          `aria-label` carries the name the rest of the app calls them by. */}
      <Group>
        <button type="button" className="fbl-btn" onClick={onBoot} disabled={audioReady || audioBooting}>
          Boot audio
        </button>
        <button
          type="button"
          className="fbl-btn fbl-btn--transport"
          data-role="play"
          aria-label="Play"
          title="Play"
          onClick={onPlay}
          disabled={!audioReady || transportState === "playing"}
        >
          ▶
        </button>
        <button
          type="button"
          className="fbl-btn fbl-btn--transport"
          data-role="stop"
          aria-label="Stop"
          title="Stop"
          onClick={onStop}
          disabled={!audioReady || transportState === "stopped"}
        >
          ■
        </button>
        <button
          type="button"
          className="fbl-btn fbl-btn--transport"
          data-role="rec"
          data-testid="record-button"
          data-on={recording}
          data-tone="coral"
          aria-label="Record"
          aria-pressed={recording}
          onClick={onRecord}
          disabled={!audioReady || recording}
          title="Record what you play on the computer keyboard into a clip — Stop commits the take"
        >
          ●
        </button>
      </Group>

      {/* The QWERTY piano: a s d f g h j k l ; are the white keys, w e t y u
          o p the black ones, z/x shift the octave and c/v the velocity.
          Nothing else on screen says which C the `a` key is. */}
      {/* The QWERTY piano's live state, and the way in to the map that
          explains it: a tooltip is not where you look for "which C does `a`
          play", so the readout is the button that answers. */}
      <button
        type="button"
        className="fbl-status fbl-status--plain fbl-status--button"
        data-testid="keyboard-readout"
        onClick={onShowShortcuts}
        title="Computer keyboard: a-; play white keys, w/e/t/y/u/o/p black; z/x octave, c/v velocity — click for the full map"
      >
        Oct {keyboardOctave} · Vel {keyboardVelocity}
      </button>

      <Sep />

      <Group label="Edit">
        <button
          type="button"
          className="fbl-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title={undoLabel !== undefined ? `Undo ${undoLabel}` : undefined}
          data-testid="undo-button"
        >
          Undo
        </button>
        <button
          type="button"
          className="fbl-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title={redoLabel !== undefined ? `Redo ${redoLabel}` : undefined}
          data-testid="redo-button"
        >
          Redo
        </button>
        <button
          type="button"
          className="fbl-btn"
          data-testid="reenable-automation"
          data-on={hasOverrides}
          data-tone="amber"
          title="Re-enable automation (SS4): restore every overridden param to its lane"
          onClick={onReenableAutomation}
          disabled={!hasOverrides}
        >
          Re-enable
        </button>
      </Group>

      <Sep />

      <Group label="Tools">
        {/* One segmented control, not two buttons that happen to sit next to
            each other: the pair is a single choice, and it should look it. */}
        <span className="fbl-enum-segmented" role="radiogroup" aria-label="Piano roll tool">
          <button
            type="button"
            role="radio"
            className="fbl-enum-cell"
            aria-checked={tool === "select"}
            onClick={() => onToolChange("select")}
            title="Select tool — marquee and drag"
            data-testid="tool-select-button"
          >
            Select
          </button>
          <button
            type="button"
            role="radio"
            className="fbl-enum-cell"
            aria-checked={tool === "pencil"}
            onClick={() => onToolChange("pencil")}
            title="Pencil tool — drag on empty grid to create notes"
            data-testid="tool-pencil-button"
          >
            Pencil
          </button>
        </span>

        <select
          className="fbl-field"
          value={gridChoiceValue(gridSettings)}
          onChange={handleGridChange}
          data-testid="grid-select"
          aria-label="Grid"
          title="Snap grid (SS10) — adaptive follows the zoom level"
        >
          {GRID_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <label className="fbl-checkbox-label" title="Snap to triplet subdivisions">
          <input
            type="checkbox"
            className="fbl-check"
            checked={gridSettings.triplet}
            onChange={(event) => onGridChange({ triplet: event.target.checked })}
            data-testid="grid-triplet-toggle"
          />
          Triplet
        </label>
        <button
          type="button"
          className="fbl-btn"
          data-testid="loop-clip-button"
          onClick={onLoopClip}
          disabled={!canLoopClip}
          title="Loop the selected clip(s) — drag the clip's right edge to unroll repeats (Cmd/Ctrl+L)"
        >
          Loop Clip
        </button>
      </Group>

      <Sep />

      <Group label="File">
        <button type="button" className="fbl-btn" onClick={onNewProject}>
          New
        </button>
        <button type="button" className="fbl-btn" onClick={onSaveNow} data-testid="save-button">
          Save
        </button>
        <button type="button" className="fbl-btn" onClick={onExport} data-testid="export-button">
          Export…
        </button>
        <button type="button" className="fbl-btn" onClick={handleImportClick} data-testid="import-button">
          Import…
        </button>
        <button
          type="button"
          className="fbl-btn"
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
      </Group>

      {/* Everything after the spacer is READOUT, never a verb — so the right
          edge of the strip is a place to look, not a place to click. */}
      <span className="fbl-tb-spacer" />

      {statusMessage !== undefined && statusMessage !== null && (
        <span className="fbl-status-message" data-testid="toolbar-status-message" title={statusMessage}>
          {statusMessage}
        </span>
      )}
      <span
        className="fbl-status"
        data-tone={autosaveTone(autosaveState, autosaveAvailable)}
        data-testid="autosave-status"
        title={
          autosaveError ??
          (autosaveAvailable ? undefined : "This browser has no local project storage (OPFS).")
        }
      >
        {autosaveLabel(autosaveState, autosaveAvailable)}
      </span>
      <span
        className="fbl-status"
        data-tone={audioTone(audioStatus, audioReady)}
        data-testid="audio-status"
        title="Audio engine"
      >
        {audioStatus}
      </span>
      <span
        className="fbl-status"
        data-tone={transportState === "playing" ? "live" : "off"}
        data-testid="transport-state"
        title="Transport"
      >
        {transportState}
      </span>
      <button
        type="button"
        className="fbl-btn fbl-btn--icon"
        data-testid="shortcuts-button"
        onClick={onShowShortcuts}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
      >
        ?
      </button>
    </div>
  );
}
