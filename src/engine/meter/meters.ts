// SS6 "Metering" — the main-thread half.
//
// Primary path: one `fableton-meter` worklet node per strip, all writing
// into ONE SharedArrayBuffer slab (slab.ts); the UI reads `frame()` at rAF.
// Needs `crossOriginIsolated` (COOP/COEP is already set by vite.config.ts,
// SS15) plus a real `AudioWorkletNode` — when either is missing the bus
// falls back to an `AnalyserNode` per strip, polled at read time, exactly as
// SS6 allows. Under the test fakes (no analyser either) it degrades to a
// silent bus, so engine tests need no audio at all.
//
// Meters are UI-only and never enter the document (SS13). Ballistics
// (peak decay) are applied here, on the reader side, per slab.ts.

import type { ChannelId } from "../../types";
import type { MeterFrame } from "../../types/graph";
import meterWorkletUrl from "../../worklets/meter-processor.ts?worker&url";
import { METER_PROCESSOR_NAME } from "./processorName";
import {
  DEFAULT_SLOT_COUNT,
  blockPeakRms,
  decayed,
  readMeterSlot,
  slabByteLength,
} from "./slab";

export interface MeterBus {
  /** Resolves when the worklet module (if used) is loaded. */
  readonly ready: Promise<void>;
  /** Which transport the meters actually use, for diagnostics. */
  readonly kind: "worklet" | "analyser" | "none";
  /** Taps `node` for `channelId`'s strip. Re-attaching replaces the tap. */
  attach(channelId: ChannelId, node: AudioNode): void;
  detach(channelId: ChannelId): void;
  /** Latest frame with ballistics applied; call at rAF. */
  frame(channelId: ChannelId): MeterFrame | undefined;
  dispose(): void;
}

interface WorkletTap {
  kind: "worklet";
  node: AudioNode;
  meter: AudioWorkletNode;
  slot: number;
}

interface AnalyserTap {
  kind: "analyser";
  node: AudioNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
}

type Tap = WorkletTap | AnalyserTap;

interface Ballistics {
  peak: number;
  rms: number;
  at: number;
}

export function createMeterBus(ctx: BaseAudioContext): MeterBus {
  const taps = new Map<ChannelId, Tap>();
  const shown = new Map<ChannelId, Ballistics>();
  /**
   * Worklet attach is DEFERRED behind `ready` (the module is still loading),
   * so the node an attach was scheduled for has to be remembered: inside that
   * window the reconciler can hand the same channel a different post node
   * (a channel deleted and re-created, a reconcile racing the first apply),
   * and a callback that fires against the stale node binds the meter to a
   * node nothing plays through — a permanently dark strip. Last attach wins;
   * every earlier pending callback sees its node superseded and bails.
   */
  const pendingNodes = new Map<ChannelId, AudioNode>();
  const freeSlots: number[] = [];
  let disposed = false;

  const sabSupported =
    typeof SharedArrayBuffer !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated === true &&
    typeof ctx.audioWorklet?.addModule === "function";

  const analyserSupported = typeof (ctx as AudioContext).createAnalyser === "function";

  let slabView: Float32Array | null = null;
  let kind: MeterBus["kind"] = "none";
  let ready: Promise<void> = Promise.resolve();
  let workletAttach: ((channelId: ChannelId, node: AudioNode) => void) | undefined;

  if (sabSupported) {
    kind = "worklet";
    const sab = new SharedArrayBuffer(slabByteLength(DEFAULT_SLOT_COUNT));
    slabView = new Float32Array(sab);
    for (let i = DEFAULT_SLOT_COUNT - 1; i >= 0; i--) freeSlots.push(i);
    ready = ctx.audioWorklet.addModule(meterWorkletUrl).catch(() => {
      // Module failed to load (CSP, dev-server hiccup): stay silent rather
      // than crash the engine; the UI simply shows dark meters.
      kind = "none";
    });
    // The slab reaches each node via processorOptions at attach time.
    const attachWorklet = (channelId: ChannelId, node: AudioNode): void => {
      const slot = freeSlots.pop();
      if (slot === undefined) return; // out of slots: dark meter, not a crash
      const meter = new AudioWorkletNode(ctx, METER_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { sab, slot },
      });
      node.connect(meter);
      taps.set(channelId, { kind: "worklet", node, meter, slot });
    };
    workletAttach = attachWorklet;
  } else if (analyserSupported) {
    kind = "analyser";
  }

  function detachTap(channelId: ChannelId): void {
    const tap = taps.get(channelId);
    if (tap === undefined) return;
    try {
      if (tap.kind === "worklet") {
        tap.node.disconnect(tap.meter);
        tap.meter.disconnect();
        freeSlots.push(tap.slot);
      } else {
        tap.node.disconnect(tap.analyser);
      }
    } catch {
      // The tap node may already be gone (channel deleted) — fine.
    }
    taps.delete(channelId);
    shown.delete(channelId);
  }

  /** Detach plus "cancel any attach still waiting on `ready`". */
  function dropTap(channelId: ChannelId): void {
    pendingNodes.delete(channelId);
    detachTap(channelId);
  }

  function now(): number {
    return typeof performance === "undefined" ? Date.now() / 1000 : performance.now() / 1000;
  }

  return {
    ready,
    get kind() {
      return kind;
    },

    attach(channelId: ChannelId, node: AudioNode): void {
      if (disposed) return;
      const existing = taps.get(channelId);
      if (existing !== undefined && existing.node === node) return;
      if (pendingNodes.get(channelId) === node) return; // already on its way
      dropTap(channelId);
      if (kind === "worklet" && workletAttach !== undefined) {
        pendingNodes.set(channelId, node);
        void ready.then(() => {
          if (disposed) return;
          // Superseded by a later attach (or cancelled by a detach) while the
          // module loaded — that call owns the strip now.
          if (pendingNodes.get(channelId) !== node) return;
          pendingNodes.delete(channelId);
          // `ready` also resolves when `addModule` FAILED, and `kind` is
          // 'none' by then: constructing an `AudioWorkletNode` for a
          // processor that was never registered would throw.
          if (kind !== "worklet") return;
          workletAttach?.(channelId, node);
        });
      } else if (kind === "analyser") {
        const analyser = (ctx as AudioContext).createAnalyser();
        analyser.fftSize = 1024;
        node.connect(analyser);
        taps.set(channelId, {
          kind: "analyser",
          node,
          analyser,
          buffer: new Float32Array(analyser.fftSize),
        });
      }
    },

    detach: dropTap,

    frame(channelId: ChannelId): MeterFrame | undefined {
      const tap = taps.get(channelId);
      if (tap === undefined) return undefined;
      let raw: { peak: number; rms: number };
      if (tap.kind === "worklet") {
        if (slabView === null) return undefined;
        raw = readMeterSlot(slabView, tap.slot);
      } else {
        tap.analyser.getFloatTimeDomainData(tap.buffer);
        raw = blockPeakRms([tap.buffer]);
      }
      const t = now();
      const previous = shown.get(channelId) ?? { peak: 0, rms: 0, at: t };
      const dt = Math.max(0, t - previous.at);
      const frame: Ballistics = {
        peak: decayed(previous.peak, raw.peak, dt),
        rms: decayed(previous.rms, raw.rms, dt, 20),
        at: t,
      };
      shown.set(channelId, frame);
      return { peak: frame.peak, rms: frame.rms };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      pendingNodes.clear();
      for (const channelId of [...taps.keys()]) detachTap(channelId);
    },
  };
}
