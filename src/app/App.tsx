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
import { connectParamRegistry, createEmptyProject, defaultIdFactory, projectCommands } from "../state";
import { ticksPerBar } from "../time";
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
import {
  DEFAULT_OCTAVE,
  DEFAULT_VELOCITY,
  createKeyboardPiano,
  type KeyboardPiano,
} from "./keyboardPiano";
import { createNoteRecorder } from "./noteRecorder";
import { createProjectEngine, type AppProjectEngine } from "./engine";
import { createUndoRedoHandler, isEditableTarget } from "./keyboard";
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

/** The bottom pane's three views (SS18-M2). A table, so the tab strip is one
 *  `map` instead of three near-identical buttons that drift apart. */
/** Bottom-pane sizing. A third of the window is the ratio the pane had when
 *  it was a fixed `flex: 1` against the arrangement's `flex: 2`; the clamp
 *  keeps a short window from opening on a pane too small to show a mixer
 *  strip, and a tall one from burying the arrangement. From there it is the
 *  user's to drag. */
const MIN_BOTTOM_HEIGHT_PX = 120;
const MIN_TOP_HEIGHT_PX = 120;

function defaultBottomHeight(): number {
  const viewport = typeof window === "undefined" ? 900 : window.innerHeight;
  return Math.max(240, Math.min(520, Math.round(viewport / 3)));
}

const BOTTOM_TABS = [
  { id: "pianoroll", label: "Piano Roll" },
  { id: "mixer", label: "Mixer" },
  { id: "automation", label: "Automation" },
] as const;

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

  /** How tall the bottom pane is, in CSS px. A mixer strip is ~300 px of
   *  controls and the piano roll wants as much room as it can get, so the
   *  split between the two has to be the user's to set — a fixed 1:2 ratio
   *  clips whichever one they are actually working in. The canvas editors
   *  re-measure through the kit's `ResizeObserver` (SS9), so dragging this
   *  needs no editor plumbing at all. */
  const [bottomHeight, setBottomHeight] = useState(defaultBottomHeight);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const onSplitterDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (body === null) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      const rect = body.getBoundingClientRect();
      const fromBottom = rect.bottom - e.clientY;
      setBottomHeight(
        Math.max(MIN_BOTTOM_HEIGHT_PX, Math.min(rect.height - MIN_TOP_HEIGHT_PX, fromBottom)),
      );
    };
    const up = (): void => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
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
  /** SS10/SS12 keyboard performance: the computer keyboard plays the selected
   *  track's instrument, and `Rec` captures what is played into a clip. */
  const [recording, setRecording] = useState(false);
  const [keyboardState, setKeyboardState] = useState({
    octave: DEFAULT_OCTAVE,
    velocity: DEFAULT_VELOCITY,
  });
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
  const selectedChannelIdRef = useRef<ChannelId | null>(null);
  selectedChannelIdRef.current = selectedChannelId;

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

  /**
   * Which track the computer keyboard plays. The SELECTION is what a user
   * means by "this track" — the mixer strip, the arrangement header and the
   * device chain all follow it — and the open clip's track is the fallback
   * for someone who has only been in the piano roll.
   */
  const keyboardTrackId = (): ChannelId | undefined => {
    const bootstrap = docStateRef.current;
    if (bootstrap === null) return undefined;
    const doc = bootstrap.store.getState();
    const selected = selectedChannelIdRef.current;
    if (selected !== null && doc.channels[selected]?.role === "track") return selected;
    const clipId = openClipIdRef.current;
    const fromClip = clipId === null ? undefined : doc.clips[clipId]?.trackId;
    if (fromClip !== undefined) return fromClip;
    return doc.channelOrder.find((id) => doc.channels[id]?.role === "track");
  };

  const recorderRef = useRef(
    createNoteRecorder(() => engineRef.current?.transport.positionTicks() ?? 0),
  );
  const recordingRef = useRef(false);
  recordingRef.current = recording;
  const recordTrackRef = useRef<ChannelId | null>(null);

  /** The keyboard's sink: sound it now, and capture it if we are recording.
   *  Auditions are UI, never scheduled (SS10) — the recorder is what makes a
   *  played note reach the document, and only while `Rec` is on. */
  const keyboardPianoRef = useRef<KeyboardPiano | null>(null);
  if (keyboardPianoRef.current === null) {
    keyboardPianoRef.current = createKeyboardPiano({
      onChange: setKeyboardState,
      sink: () => {
        const trackId = recordingRef.current
          ? (recordTrackRef.current ?? keyboardTrackId())
          : keyboardTrackId();
        const audition = trackId === undefined ? undefined : engineRef.current?.auditionFor(trackId);
        return {
          noteOn(pitch: number, velocity: number): void {
            audition?.noteOn(pitch, velocity);
            if (recordingRef.current) recorderRef.current.noteOn(pitch, velocity);
          },
          noteOff(pitch: number): void {
            audition?.noteOff(pitch);
            if (recordingRef.current) recorderRef.current.noteOff(pitch);
          },
        };
      },
    });
  }

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

  // --- 3b. the computer keyboard as a MIDI keyboard ---------------------
  //
  // Window level, like undo/redo, and equally narrow: it backs off while the
  // user is typing in a field, and ignores anything with a modifier so no
  // editor shortcut (all of which are modified or arrow keys) is shadowed.
  useEffect(() => {
    const piano = keyboardPianoRef.current;
    if (piano === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (piano.keyDown(event.key, { repeat: event.repeat }) !== "ignored") {
        // Space would scroll, and the letter keys would type into anything
        // that picks up a bare keypress.
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      piano.keyUp(event.key);
    };
    // A window that loses focus never delivers the keyup, so every held note
    // would sound forever.
    const onBlur = (): void => piano.releaseAll();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      piano.releaseAll();
    };
  }, []);

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

  /**
   * Writes a finished take into the document as ONE undo entry: into the clip
   * it was played over when there is one, and into a NEW clip otherwise —
   * bar-aligned, so a take started mid-bar still produces a clip that lines
   * up with the grid. Recorded ticks are SONG ticks; a clip's notes are
   * clip-relative (SS10), which is the subtraction below.
   */
  const commitTake = useCallback(() => {
    const bootstrap = docStateRef.current;
    const take = recorderRef.current.finish();
    const trackId = recordTrackRef.current;
    if (bootstrap === null || trackId === null || take.length === 0) return;
    const doc = bootstrap.store.getState();
    const first = take[0]?.start ?? 0;
    const last = take.reduce((end, note) => Math.max(end, note.start + note.dur), first);

    const openId = openClipIdRef.current;
    const openClip = openId === null ? undefined : doc.clips[openId];
    const target =
      openClip !== undefined && openClip.trackId === trackId
        ? openClip
        : Object.values(doc.clips).find(
            (clip) => clip.trackId === trackId && clip.start <= first && clip.start + clip.length > first,
          );

    if (target !== undefined) {
      bootstrap.store.dispatch(
        projectCommands.addNotes(
          target.id,
          take.map((note) => ({
            start: Math.max(0, note.start - target.start),
            dur: note.dur,
            pitch: note.pitch,
            vel: note.vel,
          })),
        ),
      );
      return;
    }

    const bar = ticksPerBar(doc.timeSignature);
    const start = Math.floor(first / bar) * bar;
    const length = Math.max(bar, Math.ceil((last - start) / bar) * bar);
    const clipId = defaultIdFactory.clip();
    bootstrap.store.dispatch(
      projectCommands.createClip({
        id: clipId,
        trackId,
        start,
        length,
        notes: take.map((note) => ({
          start: Math.max(0, note.start - start),
          dur: note.dur,
          pitch: note.pitch,
          vel: note.vel,
        })),
      }),
    );
    setOpenClipId(clipId);
  }, []);

  const handleRecord = useCallback(() => {
    const trackId = keyboardTrackId();
    if (trackId === undefined) return;
    recordTrackRef.current = trackId;
    recorderRef.current.reset();
    setRecording(true);
    engineRef.current?.transport.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStop = useCallback(() => {
    // The take is closed BEFORE the transport stops: `finish()` timestamps
    // still-held notes at the current position, and a stopped transport parks
    // the playhead back at the start point.
    if (recordingRef.current) {
      keyboardPianoRef.current?.releaseAll();
      commitTake();
      setRecording(false);
    }
    engineRef.current?.transport.stop();
  }, [commitTake]);

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
      <div id="app-root" className="fbl-app">
        <div className="fbl-empty" style={{ flex: 1 }}>
          <h1 className="fbl-brand" style={{ justifySelf: "center" }}>
            Fableton
          </h1>
          <p data-testid="app-loading">Loading project…</p>
        </div>
      </div>
    );
  }

  const store = docState.store;
  const snapshot = store.getState();

  return (
    <div id="app-root" className="fbl-app">
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
        recording={recording}
        onRecord={handleRecord}
        keyboardOctave={keyboardState.octave}
        keyboardVelocity={keyboardState.velocity}
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
      <div className="fbl-body" ref={bodyRef}>
        <div className="fbl-pane-arrangement">
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
        {/* The one piece of chrome that is pure affordance: grab it and the
            arrangement gives room to the editor below, or takes it back. */}
        <div
          className="fbl-splitter"
          data-testid="pane-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize editor pane"
          onPointerDown={onSplitterDown}
          onDoubleClick={() => setBottomHeight(defaultBottomHeight())}
          title="Drag to resize · double-click to reset"
        />
        <div className="fbl-pane-bottom" style={{ height: bottomHeight }}>
          {/* Tabs, not panes stacked behind borders: the underline names the
              active view and the pane below is the only surface, so the eye
              is never asked to parse two adjacent edges. */}
          <div role="tablist" className="fbl-tabs" aria-label="Editor">
            {BOTTOM_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className="fbl-tab"
                aria-selected={bottomTab === tab.id}
                data-testid={`tab-${tab.id}`}
                onClick={() => setBottomTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {/* The piano roll view is a canvas component built imperatively per
              (store, commands) — hiding it with CSS instead of unmounting
              keeps its viewport/selection alive across tab flips. */}
          <div className="fbl-tab-panel" style={{ display: bottomTab === "pianoroll" ? "block" : "none" }}>
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
            <div className="fbl-tab-panel">
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
            <div className="fbl-split">
              <div>
                <MixerPanel
                  store={store}
                  commands={projectCommands}
                  engine={engine}
                  selectedChannelId={selectedChannelId}
                  onSelectChannel={setSelectedChannelId}
                  onShowAutomation={handleShowAutomation}
                />
              </div>
              <div style={{ overflow: "auto" }}>
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
