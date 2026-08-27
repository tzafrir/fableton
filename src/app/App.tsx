// App chrome root (SS15: "React (chrome only)"). Editors and other
// bounded-by-count-but-not-DOM UI mount as opaque canvas components inside
// this tree via an imperative bridge, starting in M1.
//
// M0's whole job: a boot/unlock button, then play/stop for the hard-coded
// clip through the registered core.poly-synth -> core.filter -> destination
// chain (SS18-M0, src/demo/), plus one live control so the SS3/SS4 param
// bridge is exercised by the shipped app and not only by its tests.
import { useCallback, useEffect, useRef, useState } from "react";
import { bootAudioContext } from "../engine/context";
import { createDemoEngine, DEMO_CUTOFF_PARAM_ID, type DemoEngine } from "../demo";
import { fromNormalized, toNormalized } from "../params";
import type { ParamHandle, TransportState, Unsub } from "../types";

export interface AppProps {
  /** Called once the demo chain is mounted. `src/main.tsx` uses it to hand
   *  the live engine to the e2e bridge; nothing in the app itself needs it. */
  onEngineReady?: ((engine: DemoEngine) => void) | undefined;
}

export function App({ onEngineReady }: AppProps = {}) {
  const [status, setStatus] = useState("idle");
  const [ready, setReady] = useState(false);
  const [booting, setBooting] = useState(false);
  const [transportState, setTransportState] = useState<TransportState>("stopped");
  const [cutoffNorm, setCutoffNorm] = useState(0);
  const [cutoffText, setCutoffText] = useState("");
  const engineRef = useRef<DemoEngine | null>(null);
  const cutoffRef = useRef<ParamHandle | null>(null);
  const cutoffUnsubRef = useRef<Unsub | null>(null);
  const stateUnsubRef = useRef<Unsub | null>(null);
  // Set synchronously, unlike the state above: two clicks in the same frame
  // would otherwise both get past the guard while the first is still awaiting
  // `bootAudioContext`, leaving a second AudioContext + chain alive forever.
  const bootingRef = useRef(false);

  // Deliberately gesture-triggered: AudioContext boot needs a user gesture
  // to unlock in most browsers (SS18-M0: "Context boot + unlock"; SS12's
  // guardrail is what `bootAudioContext` wires up). Clicking this also
  // exercises the worklet-loading seam end to end — `core.poly-synth`'s
  // `prepare()` (src/devices/core/polySynth.ts) is what pulls
  // poly-synth-processor.ts into the build as its own chunk.
  const handleBoot = useCallback(async () => {
    if (bootingRef.current || engineRef.current) return;
    bootingRef.current = true;
    setBooting(true);
    setStatus("booting");
    try {
      const context = await bootAudioContext();
      const engine = await createDemoEngine(context, context.destination);
      stateUnsubRef.current?.();
      stateUnsubRef.current = engine.transport.onStateChange(setTransportState);
      engineRef.current = engine;
      const cutoff = engine.params.get(DEMO_CUTOFF_PARAM_ID) ?? null;
      cutoffRef.current = cutoff;
      if (cutoff !== null) {
        setCutoffNorm(toNormalized(cutoff.desc, cutoff.live()));
        setCutoffText(cutoff.desc.toText(cutoff.live()));
        // The read half of the SS4 bridge. Without it the control only ever
        // shows what IT wrote: an automation-path `setLive(v, "automation")`
        // (M3), a registry `load()` or an undo's `setBase` would leave the
        // slider and its readout stale. `onChange` is coalesced to rAF
        // precisely so a control can repaint from every write (SS4/SS5).
        cutoffUnsubRef.current?.();
        cutoffUnsubRef.current = cutoff.onChange((value) => {
          setCutoffNorm(toNormalized(cutoff.desc, value));
          setCutoffText(cutoff.desc.toText(value));
        });
      }
      onEngineReady?.(engine);
      setReady(true);
      setStatus(`ready (worklet loaded, state=${context.state})`);
    } catch (error) {
      setStatus(`failed: ${String(error)}`);
    } finally {
      // Both flags, not just the state one: `bootingRef` guards the in-flight
      // window only. Leaving it latched after a failed boot (a rejected
      // `addModule`, a throwing `createDemoEngine`) would dead-end the button
      // for the rest of the page's life while it still looks clickable —
      // `disabled={ready || booting}` re-enables it, then every click returns
      // at the guard.
      bootingRef.current = false;
      setBooting(false);
    }
  }, [onEngineReady]);

  // Unmount teardown. `DemoEngine.dispose()` stops the transport (and with it
  // the 25 ms worker clock), disposes every mounted device and unregisters
  // their params (SS7 "Removal is the reverse, gain-ramped"); without it a
  // remount leaves the previous engine's clock ticking, its worklet nodes
  // connected to `destination` and its subscriptions holding React state
  // setters for an unmounted tree.
  useEffect(
    () => () => {
      cutoffUnsubRef.current?.();
      cutoffUnsubRef.current = null;
      stateUnsubRef.current?.();
      stateUnsubRef.current = null;
      cutoffRef.current = null;
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    [],
  );

  const handlePlay = useCallback(() => {
    engineRef.current?.transport.play();
  }, []);

  const handleStop = useCallback(() => {
    engineRef.current?.transport.stop();
  }, []);

  // SS3 fast path A: the drag writes straight to the engine at gesture rate
  // (no document churn), and gesture end commits exactly one value — the
  // command/undo entry M1 subscribes to via `ParamRegistry.onCommit`.
  const handleCutoffInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const handle = cutoffRef.current;
    const normalized = Number(event.target.value);
    // Painted from the gesture itself as well as from `onChange` above: the
    // dragging control must not wait a frame to follow the pointer (SS5).
    setCutoffNorm(normalized);
    if (handle === null) return;
    const real = fromNormalized(handle.desc, normalized);
    handle.setLive(real, "user");
    setCutoffText(handle.desc.toText(real));
  }, []);

  const handleCutoffCommit = useCallback(() => {
    cutoffRef.current?.commit();
  }, []);

  return (
    <div id="app-root">
      <h1>Fableton</h1>
      <p>M0 spine: a hard-coded clip through synth -&gt; filter -&gt; destination.</p>
      <button
        type="button"
        onClick={() => void handleBoot()}
        disabled={ready || booting}
      >
        Boot audio
      </button>
      <button type="button" onClick={handlePlay} disabled={!ready}>
        Play
      </button>
      <button type="button" onClick={handleStop} disabled={!ready}>
        Stop
      </button>
      <p>
        <label htmlFor="filter-cutoff">Filter cutoff </label>
        <input
          id="filter-cutoff"
          data-testid="filter-cutoff"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={cutoffNorm}
          disabled={!ready}
          onChange={handleCutoffInput}
          onPointerUp={handleCutoffCommit}
          onKeyUp={handleCutoffCommit}
          onBlur={handleCutoffCommit}
        />
        <span data-testid="filter-cutoff-value">{cutoffText}</span>
      </p>
      <p data-testid="audio-status">{status}</p>
      <p data-testid="transport-state">{transportState}</p>
    </div>
  );
}
