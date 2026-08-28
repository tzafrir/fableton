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
  ParamDescriptor,
  ParamId,
  ProjectCommands,
} from "../../types";
import { useDispatchHint } from "./useDispatchHint";

/** One "show me this param's lane" request from SS5's control context menu.
 *  A fresh object per request (never a bare id), so asking twice for the same
 *  param still moves the selection back to it. */
export interface LaneFocusRequest {
  paramId: ParamId;
}

export interface AutomationPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId | null;
  grid?: Partial<GridSettings> | undefined;
  /** SS5 "Show/create automation lane": the shell has already created (or
   *  re-enabled) the lane; this selects it for editing. */
  focusRequest?: LaneFocusRequest | null | undefined;
}

export function AutomationPanel({
  store,
  commands,
  engine,
  channelId,
  grid,
  focusRequest,
}: AutomationPanelProps) {
  const [, force] = useState(0);
  useEffect(() => store.onChange(() => force((n) => n + 1)), [store]);
  // The add-lane menu below IS `engine.params.list()` (SS11), read during
  // render — but handles are registered asynchronously, after the reconcile
  // that mounted their device. Without this the menu is stale for the whole
  // mount window (and forever when nothing else re-renders the panel).
  // Its own tick, not `force`: it is also a cache key of the menu's `useMemo`.
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => {
    if (engine === null) return;
    return engine.params.onRegistryChange(() => setRegistryTick((n) => n + 1));
  }, [engine]);
  const { hint, dispatch } = useDispatchHint(store);
  const [selectedLaneId, setSelectedLaneId] = useState<LaneId | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<AutomationLaneView | null>(null);
  // Bumped whenever the view below is (re)created, so the lane push that
  // follows re-runs against the NEW view — it can no longer rely on the
  // document churn it used to depend on to heal itself.
  const [viewEpoch, setViewEpoch] = useState(0);

  const doc = store.getState();
  const lanes = useMemo(
    () => Object.values(doc.lanes).filter((lane) => channelId === null || lane.channelId === channelId),
    [doc, channelId],
  );
  const selectedLane = lanes.find((lane) => lane.id === selectedLaneId) ?? lanes[0];
  // Resolved here rather than inside the effect below so the effect can depend
  // on the descriptor's IDENTITY (stable for the life of a handle) instead of
  // on the document.
  const selectedDesc: ParamDescriptor | null =
    selectedLane === undefined ? null : engine?.params.get(selectedLane.paramId)?.desc ?? null;

  // The SS11 registry-filtered lane menu.
  const registryParams = useMemo(() => {
    if (engine === null || channelId === null) return [];
    return engine.params
      .list()
      .filter((handle) => isChannelParamId(handle.desc.id, channelId))
      .sort((a, b) => a.desc.id.localeCompare(b.desc.id));
    // `doc` and `registryTick` are cache keys, not reads: the list changes
    // when the document does (channels come and go) and when the registry
    // does (devices mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, channelId, doc, registryTick]);

  // --- imperative canvas bridge (same discipline as PianoRollPanel) --------
  // Grid is read once at creation and pushed on every later change through
  // `setGrid` — re-creating the view would tear the canvas down under the
  // user's hands (viewport and point selection with it).
  const initialGrid = useRef(grid);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const view = createAutomationLaneView({ container, store, commands, grid: initialGrid.current });
    viewRef.current = view;
    setViewEpoch((n) => n + 1);
    return () => {
      viewRef.current = null;
      view.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, commands]);

  // SS5's "Show automation lane" landing here: select the lane bound to the
  // param the user right-clicked. Keyed on the REQUEST object, never on the
  // document, so it selects once and then leaves the lane list alone — the
  // row the user clicks next must win.
  useEffect(() => {
    if (focusRequest === null || focusRequest === undefined) return;
    const lane = Object.values(store.getState().lanes).find(
      (candidate) => candidate.paramId === focusRequest.paramId,
    );
    if (lane !== undefined) setSelectedLaneId(lane.id);
  }, [focusRequest, store]);

  // SS10's grid override menu / triplet toggle reaches the lane editor, so a
  // point drag snaps to the same division the toolbar shows.
  useEffect(() => {
    if (grid !== undefined) viewRef.current?.setGrid(grid);
  }, [grid, viewEpoch]);

  // Keyed on the lane's ID and the descriptor, NEVER on `doc`: `setLane`
  // clears the editor's point selection and invalidates all three layers, so
  // depending on the document ran it after every dispatch — including the
  // lane editor's own. Marquee-select points and press ArrowUp: the first
  // nudge wiped the selection, leaving the second nudge (and Delete) acting
  // on nothing — SS11's "marquee + the same keyboard nudges", unusable.
  //
  // `pushedRef` makes the push idempotent for the same reason: a re-render
  // for any other cause (the view epoch below, a registry tick) must not
  // reach `setLane` with arguments it already has.
  const selectedLaneKey = selectedLane?.id ?? null;
  const pushedRef = useRef<{ view: AutomationLaneView | null; laneId: LaneId | null; desc: ParamDescriptor | null }>({
    view: null,
    laneId: null,
    desc: null,
  });
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const desc = selectedLaneKey === null ? null : selectedDesc;
    const pushed = pushedRef.current;
    if (pushed.view === view && pushed.laneId === selectedLaneKey && pushed.desc === desc) return;
    pushedRef.current = { view, laneId: selectedLaneKey, desc };
    view.setLane(selectedLaneKey, desc);
  }, [selectedLaneKey, selectedDesc, viewEpoch]);

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
    >
      <div className="fbl-lane-list">
        <select
          className="fbl-field"
          data-testid="add-lane-select"
          aria-label="Add automation lane"
          value=""
          disabled={engine === null || channelId === null}
          onChange={(e) => {
            if (channelId !== null && e.target.value !== "") {
              dispatch(commands.addLane(channelId, e.target.value));
            }
          }}
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

        {/* SS6's inline hint: `dispatch` reports any rejected lane edit here
            rather than letting it look like nothing happened. */}
        {hint !== null && (
          <span className="fbl-hint" data-testid="automation-hint" role="status">
            {hint}
          </span>
        )}

        {lanes.length === 0 && (
          <span className="fbl-empty" style={{ padding: "18px 6px", height: "auto" }}>
            <strong>No automation lanes</strong>
            <span>
              Right-click any knob or fader and choose <em>Show automation lane</em>.
            </span>
          </span>
        )}
        {lanes.map((lane) => {
          const live = engine?.params.get(lane.paramId) !== undefined;
          const selected = lane.id === selectedLane?.id;
          return (
            <div
              key={lane.id}
              className="fbl-lane-row"
              data-testid={`lane-row-${lane.id}`}
              data-selected={selected}
              // SS7: a lane without a live param is kept, greyed.
              data-live={live}
              onClick={() => setSelectedLaneId(lane.id)}
            >
              <input
                type="checkbox"
                className="fbl-check"
                data-testid={`lane-enabled-${lane.id}`}
                aria-label="Lane enabled"
                checked={lane.enabled}
                onChange={(e) => dispatch(commands.setLaneEnabled(lane.id, e.target.checked))}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="fbl-lane-name" title={lane.paramId}>
                {lane.paramId.split("/").slice(1).join("/")}
              </span>
              {!live && engine !== null && (
                <select
                  className="fbl-field fbl-field--sm"
                  style={{ maxWidth: 62 }}
                  data-testid={`lane-rebind-${lane.id}`}
                  aria-label="Re-bind lane"
                  value=""
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (e.target.value !== "") dispatch(commands.rebindLane(lane.id, e.target.value));
                  }}
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
                className="fbl-btn fbl-btn--tiny fbl-btn--ghost"
                data-testid={`lane-delete-${lane.id}`}
                title="Delete lane"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch(commands.deleteLanes([lane.id]));
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div ref={containerRef} className="fbl-lane-editor" data-testid="automation-lane-editor" />
    </div>
  );
}
