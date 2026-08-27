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
import { connectParamRegistry, createEmptyProject, projectCommands } from "../state";
import type {
  AuditionSink,
  AutosaveState,
  ChannelId,
  ClipId,
  DocumentStore,
  PianoRollView,
  Project,
  ProjectStorage,
  ArrangementView,
  Ticks,
  ToolMode,
  TransportState,
} from "../types";
import { createProjectEngine, type AppProjectEngine } from "./engine";
import { createUndoRedoHandler } from "./keyboard";
import { ArrangementPanel, PianoRollPanel, Toolbar } from "./panels";
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

  const arrangementViewRef = useRef<ArrangementView | null>(null);
  const pianoRollViewRef = useRef<PianoRollView | null>(null);

  // A stable proxy handed to the piano roll ONCE (SS15 opaque-component
  // boundary): its target is redirected as the open clip/engine change,
  // instead of remounting the editor every time (`PianoRollOptions.audition`
  // is create-time-only).
  const currentAuditionRef = useRef<AuditionSink | undefined>(undefined);
  const auditionProxyRef = useRef<AuditionSink>({
    noteOn(pitch, vel) {
      currentAuditionRef.current?.noteOn(pitch, vel);
    },
    noteOff(pitch) {
      currentAuditionRef.current?.noteOff(pitch);
    },
    allNotesOff() {
      currentAuditionRef.current?.allNotesOff();
    },
  });

  // --- 1. load or create the project on mount ---------------------------
  useEffect(() => {
    let cancelled = false;
    void bootstrapProject(storage).then((result) => {
      if (cancelled) return;
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

  // --- 5. wire the engine to the document once both exist ---------------
  useEffect(() => {
    if (docState === null || engine === null) return;
    const unsubParams = connectParamRegistry(docState.store, engine.params);
    const unsubApply = docState.store.onChange((change) => {
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
    };
    pushOnce();
    if (transportState !== "playing") return;
    let raf = requestAnimationFrame(function loop() {
      pushOnce();
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [engine, transportState]);

  // --- 7. redirect the audition proxy as the open clip/engine change -----
  useEffect(() => {
    if (docState === null || engine === null || openClipId === null) {
      currentAuditionRef.current = undefined;
      return;
    }
    const trackId: ChannelId | undefined = docState.store.getState().clips[openClipId]?.trackId;
    currentAuditionRef.current = trackId !== undefined ? engine.auditionFor(trackId) : undefined;
  }, [docState, engine, openClipId]);

  // --- 8. teardown on unmount ---------------------------------------------
  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      docState?.autosave.dispose();
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
    try {
      const ctx = await bootAudioContext();
      const nextEngine = createProjectEngine(ctx, ctx.destination, docState.store.getState());
      nextEngine.transport.onStateChange(setTransportState);
      engineRef.current = nextEngine;
      // Mount the document's instruments — and with them the poly-synth
      // worklet module — BEFORE reporting ready. `applyDocument` awaits every
      // device's `prepare()` (SS7), so without this the button says "ready"
      // while `addModule()` is still in flight and the first Play after boot
      // is silent. M0's `createDemoEngine` awaited the same work; the M1
      // engine just gets the device set from the document (SS3) instead of a
      // hard-coded chain.
      await nextEngine.applyDocument(docState.store.getState());
      setEngine(nextEngine);
      setAudioStatus(`ready (worklet loaded, state=${ctx.state})`);
      onEngineReady?.(nextEngine);
    } catch (error) {
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
    setOpenClipId(null);
    docState.store.replaceDocument(createEmptyProject());
    setStatusMessage(null);
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
        projectName={snapshot.name}
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
        autosaveState={autosaveState}
        autosaveError={autosaveError}
        onSaveNow={handleSaveNow}
        onNewProject={handleNewProject}
        onExport={handleExport}
        onImportFile={handleImportFile}
        statusMessage={loadError ?? statusMessage}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 2, minHeight: 0 }}>
          <ArrangementPanel
            store={store}
            commands={projectCommands}
            onSeek={handleSeek}
            onOpenClip={setOpenClipId}
            viewRef={arrangementViewRef}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, borderTop: "1px solid #333" }}>
          <PianoRollPanel
            store={store}
            commands={projectCommands}
            clipId={openClipId}
            tool={tool}
            onSeek={handleSeek}
            audition={auditionProxyRef.current}
            viewRef={pianoRollViewRef}
          />
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
