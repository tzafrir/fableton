// SS11/SS18-M3 — the automation panel: lane list + the kit lane editor.
//
// The lane-creation menu is LITERALLY a filtered view of the registry (SS11)
// — every param whose id belongs to the selected channel, mixer and device
// params alike. A lane whose param has no live handle (device removed,
// definition changed) renders greyed with a re-bind select (SS7: "kept,
// greyed, and re-bindable — never silently deleted").

import { useEffect, useMemo, useRef, useState } from "react";
import { createAutomationLaneView, type AutomationLaneView } from "../../editor/automation/view";
import { isChannelParamId } from "../../params";
import type { AppProjectEngine } from "../engine";
import type {
  ChannelId,
  DocumentStore,
  GridSettings,
  LaneId,
  ProjectCommands,
} from "../../types";

export interface AutomationPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId | null;
  grid?: Partial<GridSettings> | undefined;
}

export function AutomationPanel({ store, commands, engine, channelId, grid }: AutomationPanelProps) {
  const [, force] = useState(0);
  useEffect(() => store.onChange(() => force((n) => n + 1)), [store]);
  const [selectedLaneId, setSelectedLaneId] = useState<LaneId | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<AutomationLaneView | null>(null);

  const doc = store.getState();
  const lanes = useMemo(
    () => Object.values(doc.lanes).filter((lane) => channelId === null || lane.channelId === channelId),
    [doc, channelId],
  );
  const selectedLane = lanes.find((lane) => lane.id === selectedLaneId) ?? lanes[0];

  // The SS11 registry-filtered lane menu.
  const registryParams = useMemo(() => {
    if (engine === null || channelId === null) return [];
    return engine.params
      .list()
      .filter((handle) => isChannelParamId(handle.desc.id, channelId))
      .sort((a, b) => a.desc.id.localeCompare(b.desc.id));
  }, [engine, channelId, doc]);

  // --- imperative canvas bridge (same discipline as PianoRollPanel) --------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const view = createAutomationLaneView({ container, store, commands, grid });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, commands]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (selectedLane === undefined) {
      view.setLane(null, null);
      return;
    }
    const desc = engine?.params.get(selectedLane.paramId)?.desc ?? null;
    view.setLane(selectedLane.id, desc);
  }, [selectedLane, engine, doc]);

  // Lane-editor playhead at rAF (the app shell owns the SS11 moving-knob
  // display loop — it must run whichever tab is open).
  useEffect(() => {
    if (engine === null) return;
    let raf = requestAnimationFrame(function loop() {
      viewRef.current?.setPlayheadTicks(engine.transport.positionTicks());
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <div
      className="fbl-automation"
      data-testid="automation-panel"
      style={{ display: "flex", height: "100%", minHeight: 0 }}
    >
      <div
        style={{
          width: 230,
          borderRight: "1px solid #292929",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: 6,
          overflowY: "auto",
        }}
      >
        <select
          data-testid="add-lane-select"
          aria-label="Add automation lane"
          value=""
          disabled={engine === null || channelId === null}
          onChange={(e) => {
            if (channelId !== null && e.target.value !== "") {
              store.dispatch(commands.addLane(channelId, e.target.value));
            }
          }}
          style={{ fontSize: 11, background: "#181818", color: "#bbb" }}
        >
          <option value="" disabled>
            {engine === null
              ? "Boot audio to add lanes"
              : channelId === null
                ? "Select a channel in the mixer"
                : "+ Add lane…"}
          </option>
          {registryParams.map((handle) => (
            <option key={handle.desc.id} value={handle.desc.id}>
              {handle.desc.id.split("/").slice(1).join("/")} — {handle.desc.label}
            </option>
          ))}
        </select>

        {lanes.length === 0 && (
          <span style={{ fontSize: 11, color: "#555" }}>No automation lanes yet.</span>
        )}
        {lanes.map((lane) => {
          const live = engine?.params.get(lane.paramId) !== undefined;
          const selected = lane.id === selectedLane?.id;
          return (
            <div
              key={lane.id}
              data-testid={`lane-row-${lane.id}`}
              onClick={() => setSelectedLaneId(lane.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 4px",
                borderRadius: 3,
                background: selected ? "#20242c" : "transparent",
                // SS7: a lane without a live param is kept, greyed.
                opacity: live ? 1 : 0.45,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                data-testid={`lane-enabled-${lane.id}`}
                aria-label="Lane enabled"
                checked={lane.enabled}
                onChange={(e) => store.dispatch(commands.setLaneEnabled(lane.id, e.target.checked))}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={{ fontSize: 10, color: "#ccc", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={lane.paramId}>
                {lane.paramId.split("/").slice(1).join("/")}
              </span>
              {!live && engine !== null && (
                <select
                  data-testid={`lane-rebind-${lane.id}`}
                  aria-label="Re-bind lane"
                  value=""
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (e.target.value !== "") store.dispatch(commands.rebindLane(lane.id, e.target.value));
                  }}
                  style={{ fontSize: 9, maxWidth: 60, background: "#181818", color: "#bbb" }}
                >
                  <option value="">re-bind…</option>
                  {registryParams.map((handle) => (
                    <option key={handle.desc.id} value={handle.desc.id}>
                      {handle.desc.id.split("/").slice(1).join("/")}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                data-testid={`lane-delete-${lane.id}`}
                title="Delete lane"
                onClick={(e) => {
                  e.stopPropagation();
                  store.dispatch(commands.deleteLanes([lane.id]));
                }}
                style={{ fontSize: 10, background: "none", border: "none", color: "#777", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div ref={containerRef} data-testid="automation-lane-editor" style={{ flex: 1, minWidth: 0, position: "relative" }} />
    </div>
  );
}
