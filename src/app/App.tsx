// App chrome root (SS15: "React (chrome only)"). M1's job: wire the whole
// milestone together — arrangement lanes and the piano roll mount as opaque
// canvas components with an imperative bridge (SS15/`editor.ts`), transport
// play/stop carries over from M0, undo/redo is global (SS13's command bus),
// and save/load/export/import hit the persistence package. No editor logic
// lives in this file — every verb an edit needs already exists as a
// `ProjectCommands` factory or an `EditorView` method.

import { useCallback, useEffect, useRef, useState } from "react";
import { bootAudioContext } from "../engine/context";
import {
  downloadProjectFile,
  importProjectFile,
  projectCodec,
} from "../persist";
import { renderProjectToWav } from "../export/renderProject";
import { DEFAULT_GRID_SETTINGS } from "../editor/kit";
import { connectParamRegistry, createEmptyProject, projectCommands } from "../state";
import { parseParamId } from "../params";
import type {
  AuditionSink,
  AutosaveState,
  ChannelId,
  Command,
  ClipId,
  DocumentStore,
  GridSettings,
  ParamId,
  PianoRollView,
  Project,
  ProjectStorage,
  ArrangementView,
  Ticks,
  ToolMode,
  TransportState,
} from "../types";
import { createAuditionProxy } from "./audition";
import { createProjectEngine, type AppProjectEngine } from "./engine";
import { createUndoRedoHandler } from "./keyboard";
import type { KitArrangementView } from "../editor/arrangement";
import { ArrangementPanel, AutomationPanel, DeviceChainPanel, MixerPanel, PianoRollPanel, Toolbar } from "./panels";
import type { LaneFocusRequest } from "./panels";
import { bootstrapProject, type BootstrapResult } from "./persistence";

export interface AppProps {
  /** Called once the engine is mounted (e2e bridge only — see `src/main.tsx`);
   *  nothing in the app itself needs it. */
  onEngineReady?: ((engine: AppProjectEngine) => void) | undefined;
  /** Called once the document store is ready — a test-only hook (the same
   *  pattern as `onEngineReady`) so a headless test can dispatch commands and
   *  assert on the real store SS15 says every load-bearing seam needs.
   *  `src/main.tsx` never sets it. */
  onStoreReady?: ((store: DocumentStore) => void) | undefined;
  /** Overrides the persistence backend (tests use the in-memory double);
   *  defaults to OPFS. */
  storage?: ProjectStorage | undefined;
}

export function App({ onEngineReady, onStoreReady, storage }: AppProps = {}) {
  // --- the document: loaded/created once, then lives for the app's life ---
  const [docState, setDocState] = useState<BootstrapResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Re-render on every document change: undo/redo enablement and the
  // autosave dot both key off this without duplicating the store's own state.
  const [historyTick, setHistoryTick] = useState(0);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>("idle");
  const [autosaveError, setAutosaveError] = useState<string | null>(null);

  // --- the engine: created once "Boot audio" is clicked ---
  const [engine, setEngine] = useState<AppProjectEngine | null>(null);
  const [audioStatus, setAudioStatus] = useState("idle");
  const [audioBooting, setAudioBooting] = useState(false);
  const [transportState, setTransportState] = useState<TransportState>("stopped");
  const engineRef = useRef<AppProjectEngine | null>(null);
  const bootingRef = useRef(false); // synchronous guard, see App's M0 ancestor

  // --- which clip the piano roll shows ---
  const [openClipId, setOpenClipId] = useState<ClipId | null>(null);
  const [tool, setTool] = useState<ToolMode>("select");
  // SS18-M2: the bottom pane tabs between the piano roll and the mixer.
  const [bottomTab, setBottomTab] = useState<"pianoroll" | "mixer" | "automation">("pianoroll");
  const [selectedChannelId, setSelectedChannelId] = useState<ChannelId | null>(null);
  // SS4 transport pill: lights while any param is overridden (SS11).
  const [hasOverrides, setHasOverrides] = useState(false);
  const [exportingWav, setExportingWav] = useState(false);
  // SS10 "Snapping": the fixed-grid override + triplet toggle. Ephemeral UI
  // state (SS13) owned here and pushed into BOTH editors, so the arrangement
  // and the piano roll always snap the same way.
  const [gridSettings, setGridSettings] = useState<GridSettings>(DEFAULT_GRID_SETTINGS);

  const handleGridChange = useCallback((next: Partial<GridSettings>) => {
    setGridSettings((current) => ({ ...current, ...next }));
  }, []);


  const arrangementViewRef = useRef<ArrangementView | null>(null);

  /** SS10 clip loop, as a toolbar verb. `toggleLoop` is on the kit's widened
   *  view — the frozen `ArrangementView` promises less — so this is the one
   *  place the shell reaches for it. */
  const handleLoopClip = useCallback(() => {
    const view = arrangementViewRef.current as KitArrangementView | null;
    view?.toggleLoop();
  }, []);
  const pianoRollViewRef = useRef<PianoRollView | null>(null);

  // Refs the audition proxy below reads at call time — see `resolveAudition`.
  const docStateRef = useRef<BootstrapResult | null>(null);
  docStateRef.current = docState;
  // SS5's control context menu, "Show/create automation lane". The row exists
  // on every knob and fader; this is what it does: create the lane if the
  // param has none (`addLane` re-enables an existing one, SS11 "one lane per
  // (channel, param)"), select that channel, reveal the lane in the
  // automation tab, and tell the panel which lane to open.
  const [laneFocus, setLaneFocus] = useState<LaneFocusRequest | null>(null);
  /** How many clips the arrangement has selected — enables "Loop Clip". */
  const [clipSelectionCount, setClipSelectionCount] = useState(0);
  const handleShowAutomation = useCallback((paramId: ParamId) => {
    const store = docStateRef.current?.store;
    if (store === undefined) return;
    const parsed = parseParamId(paramId);
    if (parsed === null) return;
    store.dispatch(projectCommands.addLane(parsed.channelId, paramId));
    setSelectedChannelId(parsed.channelId);
    setBottomTab("automation");
    setLaneFocus({ paramId }); // a fresh object: asking twice still re-selects
  }, []);
  const openClipIdRef = useRef<ClipId | null>(null);
  openClipIdRef.current = openClipId;

  /** The sink the piano roll's auditions should reach RIGHT NOW (SS10).
   *  Resolved per note rather than cached, because `engine.auditionFor`
   *  captures the mounted instrument eagerly (SS7: a swap remounts the
   *  device, giving a new instance): a cached sink goes silent the moment
   *  the track's instrument changes, and — since nothing remounts the piano
   *  roll — stays silent until the user closes and reopens the clip. */
  const resolveAudition = (): AuditionSink | undefined => {
    const currentEngine = engineRef.current;
    const bootstrap = docStateRef.current;
    const clipId = openClipIdRef.current;
    if (currentEngine === null || bootstrap === null || clipId === null) return undefined;
    const trackId: ChannelId | undefined = bootstrap.store.getState().clips[clipId]?.trackId;
    return trackId === undefined ? undefined : currentEngine.auditionFor(trackId);
  };

  // A stable proxy handed to the piano roll ONCE (SS15 opaque-component
  // boundary): its target is resolved per call, instead of remounting the
  // editor every time (`PianoRollOptions.audition` is create-time-only).
  // Only the first render's `resolveAudition` is ever kept (`useRef`), which
  // is safe precisely because it reads nothing but refs.
  const auditionProxyRef = useRef<AuditionSink>(createAuditionProxy(() => resolveAudition()));

  // --- 1. load or create the project on mount ---------------------------
  useEffect(() => {
    let cancelled = false;
    void bootstrapProject(storage).then((result) => {
      if (cancelled) {
        // Resolved after unmount: nothing will ever render this store, so its
        // autosave's subscription and debounce timer have to be released here
        // (SS13) — the unmount cleanup already ran with `docStateRef` null.
        result.autosave.dispose();
        return;
      }
      docStateRef.current = result;
      setDocState(result);
      if (result.loadResult.loadError !== undefined) setLoadError(result.loadResult.loadError);
      onStoreReady?.(result.store);
    });
    return () => {
      cancelled = true;
    };
    // `storage`/`onStoreReady` are test-only overrides, read once at the
    // startup this effect represents — not reactive props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 2. re-render on document change; watch autosave status -----------
  useEffect(() => {
    if (docState === null) return;
    const unsubStore = docState.store.onChange(() => setHistoryTick((n) => n + 1));
    const unsubAutosave = docState.autosave.onStatusChange((status) => {
      setAutosaveState(status.state);
      setAutosaveError(status.error);
    });
    setAutosaveState(docState.autosave.status.state);
    return () => {
      unsubStore();
      unsubAutosave();
    };
  }, [docState]);

  // --- 3. flush a pending autosave before the tab goes away --------------
  useEffect(() => {
    if (docState === null) return;
    const flush = () => {
      void docState.autosave.flush();
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [docState]);

  // --- 4. global undo/redo (SS18-M1: Cmd/Ctrl+Z / Shift+Z) ---------------
  useEffect(() => {
    if (docState === null) return;
    const handle = createUndoRedoHandler(docState.store);
    const onKeyDown = (event: KeyboardEvent) => {
      handle(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [docState]);

  // A sensible default selection (first track) so the mixer's chain panel
  // and the automation panel have a subject before the user clicks a strip.
  useEffect(() => {
    if (docState === null) return;
    setSelectedChannelId((current) => {
      const doc = docState.store.getState();
      if (current !== null && doc.channels[current] !== undefined) return current;
      return doc.channelOrder.find((id) => doc.channels[id]?.role === "track") ?? null;
    });
  }, [docState, historyTick]);

  // --- 5. wire the engine to the document once both exist ---------------
  useEffect(() => {
    if (engine === null) return;
    setHasOverrides(engine.params.hasOverrides());
    return engine.params.onOverridesChange(setHasOverrides);
  }, [engine]);

  useEffect(() => {
    if (docState === null || engine === null) return;
    const unsubParams = connectParamRegistry(docState.store, engine.params);
    const unsubApply = docState.store.onChange((change) => {
      // `applyDocument` always resolves — a reconcile failure is reported
      // through `onApplyError` (wired in `handleBoot`) instead of rejecting,
      // so this `void` can never become an unhandled rejection.
      void engine.applyDocument(change.doc);
    });
    void engine.applyDocument(docState.store.getState());
    return () => {
      unsubParams();
      unsubApply();
    };
  }, [docState, engine]);

  // --- 6. push the DOM playhead (SS9: never invalidates a canvas) --------
  useEffect(() => {
    engineRef.current = engine;
    if (engine === null) return;
    const pushOnce = () => {
      const tick = engine.transport.positionTicks();
      arrangementViewRef.current?.setPlayheadTicks(tick);
      pianoRollViewRef.current?.setPlayheadTicks(tick);
      // SS11 moving-knob display rides the same rAF: lanes -> live values,
      // regardless of which bottom tab is open.
      engine.automation.updateDisplay(tick);
    };
    pushOnce();
    if (transportState !== "playing") return;
    let raf = requestAnimationFrame(function loop() {
      pushOnce();
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [engine, transportState]);

  // --- 7. teardown on unmount ---------------------------------------------
  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      // Through the REF, never the `docState` this closure captured: with
      // empty deps that is the first render's value — always `null` — so the
      // autosave's `store.onChange` subscription and its pending ~2 s
      // debounce timer used to outlive the component. An edit made inside
      // that window before a remount would then write the old store's bytes
      // over the new instance's (SS13).
      docStateRef.current?.autosave.dispose();
      docStateRef.current = null;
    },
    // Deliberately empty: this is unmount-only cleanup, re-reading the refs
    // at that point rather than the render that captured them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleBoot = useCallback(async () => {
    if (bootingRef.current || engineRef.current !== null || docState === null) return;
    bootingRef.current = true;
    setAudioBooting(true);
    setAudioStatus("booting");
    let nextEngine: AppProjectEngine | null = null;
    try {
      const ctx = await bootAudioContext();
      nextEngine = createProjectEngine(ctx, ctx.destination, docState.store.getState());
      nextEngine.transport.onStateChange(setTransportState);
      // A reconcile that throws no longer rejects (the engine's apply queue
      // must never poison itself), so this subscription — attached before the
      // very first apply — is how a failed mount becomes visible at all.
      nextEngine.onApplyError((error) => {
        setStatusMessage(`Audio update failed: ${String(error)}`);
      });
      // Mount the document's instruments — and with them the poly-synth
      // worklet module — BEFORE reporting ready. `applyDocument` awaits every
      // device's `prepare()` (SS7), so without this the button says "ready"
      // while `addModule()` is still in flight and the first Play after boot
      // is silent. M0's `createDemoEngine` awaited the same work; the M1
      // engine just gets the device set from the document (SS3) instead of a
      // hard-coded chain.
      await nextEngine.applyDocument(docState.store.getState());
      // Published only once the boot SUCCEEDED. `engineRef` is what the
      // re-entrancy guard above tests, so assigning it before the await left
      // a failed boot (a context that would not resume, a module that would
      // not load) with a non-null ref and a null `engine` state: every retry
      // returned at the guard and audio was unstartable for the rest of the
      // session, with nothing but a page reload to clear it.
      engineRef.current = nextEngine;
      setEngine(nextEngine);
      setAudioStatus(`ready (worklet loaded, state=${ctx.state})`);
      onEngineReady?.(nextEngine);
    } catch (error) {
      nextEngine?.dispose();
      engineRef.current = null;
      setAudioStatus(`failed: ${String(error)}`);
    } finally {
      bootingRef.current = false;
      setAudioBooting(false);
    }
  }, [docState, onEngineReady]);

  const handlePlay = useCallback(() => {
    engineRef.current?.transport.play();
  }, []);

  const handleStop = useCallback(() => {
    engineRef.current?.transport.stop();
  }, []);

  const handleUndo = useCallback(() => {
    docState?.store.undo();
  }, [docState]);

  const handleRedo = useCallback(() => {
    docState?.store.redo();
  }, [docState]);

  const handleSeek = useCallback((tick: Ticks) => {
    engineRef.current?.transport.seek(tick);
    const t = engineRef.current?.transport.positionTicks() ?? tick;
    arrangementViewRef.current?.setPlayheadTicks(t);
    pianoRollViewRef.current?.setPlayheadTicks(t);
  }, []);

  const handleSaveNow = useCallback(() => {
    void docState?.autosave.flush();
  }, [docState]);

  const handleNewProject = useCallback(() => {
    if (docState === null) return;
    // SS13: FLUSH FIRST. The pending ~2 s debounce still holds the edits of
    // the project that is open, and `replaceDocument` clears the store's dirty
    // flag — so a replacement that skips this drops every edit made inside the
    // window, and on a first run (nothing autosaved yet) the whole project,
    // because the timer would then fire against the NEW document and write it
    // under the NEW id. `flush()` encodes the outgoing bytes SYNCHRONOUSLY
    // (see `createAutosave`), so the swap below stays immediate: no window in
    // which the user's next click lands on a document that is about to be
    // replaced.
    void docState.autosave.flush();
    setOpenClipId(null);
    docState.store.replaceDocument(createEmptyProject());
    setStatusMessage(null);
  }, [docState]);

  const handleExportWav = useCallback(async () => {
    if (docState === null) return;
    setExportingWav(true);
    try {
      // SS12: the SAME engine on an OfflineAudioContext — no live audio (or
      // boot) required; worklet modules load into the offline context.
      const doc = docState.store.getState();
      const { wav, durationSeconds } = await renderProjectToWav(doc);
      const blob = new Blob([wav], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${doc.name.trim() || "untitled"}.wav`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatusMessage(`Exported ${durationSeconds.toFixed(1)}s WAV`);
    } catch (error) {
      setStatusMessage(`WAV export failed: ${String(error)}`);
    } finally {
      setExportingWav(false);
    }
  }, [docState]);

  const handleExport = useCallback(() => {
    if (docState === null) return;
    void docState.autosave.flush().then(() => {
      const project = docState.store.getState() as unknown as Project;
      downloadProjectFile(projectCodec, project);
    });
  }, [docState]);

  const handleImportFile = useCallback(
    (file: File) => {
      if (docState === null) return;
      void importProjectFile(projectCodec, file).then((result) => {
        if (!result.ok) {
          setStatusMessage(result.error);
          return;
        }
        // Same rule as New above: the outgoing project's pending autosave is
        // captured before its document is replaced (SS13).
        void docState.autosave.flush();
        setOpenClipId(null);
        docState.store.replaceDocument(result.project);
        setStatusMessage(
          result.warnings.length > 0 ? `Loaded with ${String(result.warnings.length)} warning(s).` : null,
        );
      });
    },
    [docState],
  );

  if (docState === null) {
    return (
      <div id="app-root">
        <h1>Fableton</h1>
        <p data-testid="app-loading">Loading project…</p>
      </div>
    );
  }

  const store = docState.store;
  const snapshot = store.getState();

  return (
    <div id="app-root" style={{ display: "flex", flexDirection: "column", height: "100vh", minHeight: 0 }}>
      <h1 style={{ margin: 0, padding: "4px 8px", fontSize: 14 }}>Fableton</h1>
      <Toolbar
        song={{
          projectName: snapshot.name,
          bpm: snapshot.tempo[0]?.bpm ?? 120,
          timeSignature: snapshot.timeSignature,
          loop: snapshot.loop,
          commands: projectCommands,
          dispatch: (command: Command) => {
            store.dispatch(command);
          },
        }}
        audioStatus={audioStatus}
        audioReady={engine !== null}
        audioBooting={audioBooting}
        onBoot={() => void handleBoot()}
        transportState={transportState}
        onPlay={handlePlay}
        onStop={handleStop}
        canUndo={store.canUndo()}
        undoLabel={store.undoLabel()}
        onUndo={handleUndo}
        canRedo={store.canRedo()}
        redoLabel={store.redoLabel()}
        onRedo={handleRedo}
        tool={tool}
        onToolChange={setTool}
        hasOverrides={hasOverrides}
        onReenableAutomation={() => engine?.params.reenableAutomation()}
        gridSettings={gridSettings}
        onGridChange={handleGridChange}
        canLoopClip={clipSelectionCount > 0}
        onLoopClip={handleLoopClip}
        autosaveState={autosaveState}
        autosaveError={autosaveError}
        autosaveAvailable={docState.storage.available}
        onSaveNow={handleSaveNow}
        onNewProject={handleNewProject}
        onExport={handleExport}
        onImportFile={handleImportFile}
        onExportWav={() => void handleExportWav()}
        exportingWav={exportingWav}
        statusMessage={loadError ?? statusMessage}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 2, minHeight: 0 }}>
          <ArrangementPanel
            store={store}
            commands={projectCommands}
            grid={gridSettings}
            onSeek={handleSeek}
            onOpenClip={setOpenClipId}
            // The arrangement header IS a channel selection (it paints its own
            // highlight), so it has to drive the app's `selectedChannelId` —
            // otherwise clicking track B highlights B while the device chain,
            // the automation add-lane menu and the mixer's Group/Delete
            // buttons all keep acting on the previously selected channel.
            onSelectChannel={setSelectedChannelId}
            selectedChannelId={selectedChannelId}
            viewRef={arrangementViewRef}
            onSelectionChange={setClipSelectionCount}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, borderTop: "1px solid #333", display: "flex", flexDirection: "column" }}>
          <div role="tablist" style={{ display: "flex", gap: 2, padding: "2px 8px", borderBottom: "1px solid #292929" }}>
            <button
              type="button"
              role="tab"
              aria-selected={bottomTab === "pianoroll"}
              data-testid="tab-pianoroll"
              onClick={() => setBottomTab("pianoroll")}
              style={{
                fontSize: 11,
                padding: "2px 10px",
                background: bottomTab === "pianoroll" ? "#2a2f3a" : "transparent",
                color: "#ccc",
                border: "1px solid #333",
                borderRadius: "4px 4px 0 0",
                cursor: "pointer",
              }}
            >
              Piano Roll
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={bottomTab === "mixer"}
              data-testid="tab-mixer"
              onClick={() => setBottomTab("mixer")}
              style={{
                fontSize: 11,
                padding: "2px 10px",
                background: bottomTab === "mixer" ? "#2a2f3a" : "transparent",
                color: "#ccc",
                border: "1px solid #333",
                borderRadius: "4px 4px 0 0",
                cursor: "pointer",
              }}
            >
              Mixer
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={bottomTab === "automation"}
              data-testid="tab-automation"
              onClick={() => setBottomTab("automation")}
              style={{
                fontSize: 11,
                padding: "2px 10px",
                background: bottomTab === "automation" ? "#2a2f3a" : "transparent",
                color: "#ccc",
                border: "1px solid #333",
                borderRadius: "4px 4px 0 0",
                cursor: "pointer",
              }}
            >
              Automation
            </button>
          </div>
          {/* The piano roll view is a canvas component built imperatively per
              (store, commands) — hiding it with CSS instead of unmounting
              keeps its viewport/selection alive across tab flips. */}
          <div style={{ flex: 1, minHeight: 0, display: bottomTab === "pianoroll" ? "block" : "none" }}>
            <PianoRollPanel
              store={store}
              commands={projectCommands}
              clipId={openClipId}
              tool={tool}
              grid={gridSettings}
              onSeek={handleSeek}
              audition={auditionProxyRef.current}
              viewRef={pianoRollViewRef}
            />
          </div>
          {bottomTab === "automation" && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <AutomationPanel
                store={store}
                commands={projectCommands}
                engine={engine}
                channelId={selectedChannelId}
                grid={gridSettings}
                focusRequest={laneFocus}
              />
            </div>
          )}
          {bottomTab === "mixer" && (
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <div style={{ flex: 1, minWidth: 0, borderRight: "1px solid #292929" }}>
                <MixerPanel
                  store={store}
                  commands={projectCommands}
                  engine={engine}
                  selectedChannelId={selectedChannelId}
                  onSelectChannel={setSelectedChannelId}
                  onShowAutomation={handleShowAutomation}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
                <DeviceChainPanel
                  store={store}
                  commands={projectCommands}
                  engine={engine}
                  channelId={selectedChannelId}
                  onShowAutomation={handleShowAutomation}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Referenced so `historyTick` is a real dependency of this render and
          not flagged unused — the toolbar's undo/redo enablement above reads
          `store.canUndo()`/`canRedo()` live, which only changes on a document
          change; this state exists purely to force that re-read. */}
      <span data-testid="history-tick" style={{ display: "none" }}>
        {historyTick}
      </span>
    </div>
  );
}
