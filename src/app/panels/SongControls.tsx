// SS8/SS13 song-level controls: project name, tempo, time signature, loop.
//
// Every verb here has existed and been tested since M1 (`renameProject`,
// `setTempo`, `setTimeSignature`, `setLoopRegion`) — what was missing was a
// control surface, which made every project "Untitled" at 120 bpm in 4/4
// forever. Same class of gap as M1's unreachable pencil mode.
//
// Typing is COALESCED (SS13 `coalesceKey`): a name or a tempo typed one
// keystroke at a time is one undo entry, not one per character. Committing
// on blur/Enter rather than per keystroke would lose the live tempo readout
// the transport wants, so the commands coalesce instead.

import { useEffect, useRef, useState } from "react";
import { MIN_BPM, MAX_BPM } from "../../state";
import type { LoopRegion, ProjectCommands, TimeSignature } from "../../types";

/** SS8: the denominators a bar length is actually expressible in. */
export const TIME_SIGNATURE_DENOMINATORS = [2, 4, 8, 16] as const;

export interface SongControlsProps {
  projectName: string;
  bpm: number;
  timeSignature: TimeSignature;
  loop: LoopRegion;
  commands: ProjectCommands;
  dispatch: (command: ReturnType<ProjectCommands["setTempo"]>) => void;
}

const field: React.CSSProperties = {
  background: "#181818",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 3,
  fontSize: 11,
  padding: "2px 4px",
};

export function SongControls({
  projectName,
  bpm,
  timeSignature,
  loop,
  commands,
  dispatch,
}: SongControlsProps) {
  // Local echo so typing stays responsive and a partially-typed value
  // ("12" on the way to "128") never round-trips through a clamp.
  const [nameDraft, setNameDraft] = useState(projectName);
  const [bpmDraft, setBpmDraft] = useState(String(bpm));
  const editingName = useRef(false);
  const editingBpm = useRef(false);

  useEffect(() => {
    if (!editingName.current) setNameDraft(projectName);
  }, [projectName]);
  useEffect(() => {
    if (!editingBpm.current) setBpmDraft(String(bpm));
  }, [bpm]);

  const commitBpm = (raw: string): void => {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      setBpmDraft(String(bpm));
      return;
    }
    const clamped = Math.min(MAX_BPM, Math.max(MIN_BPM, parsed));
    setBpmDraft(String(clamped));
    dispatch(commands.setTempo(clamped));
  };

  return (
    <>
      <input
        data-testid="project-name-input"
        aria-label="Project name"
        title="Project name"
        value={nameDraft}
        size={14}
        onFocus={() => {
          editingName.current = true;
        }}
        onChange={(e) => {
          setNameDraft(e.target.value);
          dispatch(commands.renameProject(e.target.value));
        }}
        onBlur={() => {
          editingName.current = false;
          setNameDraft(projectName);
        }}
        style={{ ...field, width: 130 }}
      />

      <label
        style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "#999" }}
      >
        <input
          data-testid="tempo-input"
          aria-label="Tempo in BPM"
          title={`Tempo (${MIN_BPM}–${MAX_BPM} BPM)`}
          type="number"
          min={MIN_BPM}
          max={MAX_BPM}
          step={1}
          value={bpmDraft}
          onFocus={() => {
            editingBpm.current = true;
          }}
          onChange={(e) => {
            setBpmDraft(e.target.value);
            // Commit only once the draft is a usable number, so clearing the
            // field to retype does not slam the tempo to MIN_BPM.
            const parsed = Number.parseFloat(e.target.value);
            if (Number.isFinite(parsed) && parsed >= MIN_BPM && parsed <= MAX_BPM) {
              dispatch(commands.setTempo(parsed));
            }
          }}
          onBlur={(e) => {
            editingBpm.current = false;
            commitBpm(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{ ...field, width: 58 }}
        />
        BPM
      </label>

      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
        title="Time signature"
      >
        <input
          data-testid="timesig-numerator"
          aria-label="Time signature beats per bar"
          type="number"
          min={1}
          max={32}
          value={timeSignature.numerator}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 1 && n <= 32) {
              dispatch(commands.setTimeSignature({ ...timeSignature, numerator: n }));
            }
          }}
          style={{ ...field, width: 40 }}
        />
        <span style={{ color: "#666", fontSize: 11 }}>/</span>
        <select
          data-testid="timesig-denominator"
          aria-label="Time signature beat unit"
          value={timeSignature.denominator}
          onChange={(e) =>
            dispatch(
              commands.setTimeSignature({
                ...timeSignature,
                denominator: Number.parseInt(e.target.value, 10),
              }),
            )
          }
          style={{ ...field, width: 46 }}
        >
          {TIME_SIGNATURE_DENOMINATORS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </span>

      <button
        type="button"
        data-testid="loop-toggle"
        aria-pressed={loop.enabled}
        title="Loop the transport over the arrangement's loop brace"
        onClick={() => dispatch(commands.setLoopRegion({ ...loop, enabled: !loop.enabled }))}
        style={{
          fontSize: 11,
          background: loop.enabled ? "#2d7ff0" : "#222",
          color: loop.enabled ? "#fff" : "#aaa",
          border: "1px solid #444",
          borderRadius: 3,
          padding: "2px 8px",
          cursor: "pointer",
        }}
      >
        Loop
      </button>
    </>
  );
}
