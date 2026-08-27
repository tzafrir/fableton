// SS6 — the live half of the routing seam: applies `diffGraph` patches to a
// real (or offline, or fake) `BaseAudioContext`.
//
// Responsibilities, in one place so nothing else touches AudioNodes:
//   - own the per-channel utility nodes (input/postfx/mute/vol/pan/post) and
//     per-send gains that `buildGraph` describes;
//   - mount/unmount devices through the SS7 harness (which owns param
//     registration, worklet `prepare`, and ramped disposal);
//   - register + bind MIXER params (vol dB->linear, pan, send dB->linear) —
//     SS4: "mixer params register exactly like device params";
//   - apply solo-in-place as mute-gain writes (SS6: "just gain");
//   - dip touched channel-boundary gains ~8 ms around a rewire so chain
//     reorders / swaps / regrouping are click-free (SS6 "Reconciler").
//
// The context is `BaseAudioContext` throughout (SS3/SS12): the M4 offline
// export instantiates this same reconciler on an `OfflineAudioContext`. In
// that mode (and under fakes) there is no wall clock to wait on, so patches
// apply immediately — `immediate: true`.

import type {
  ChannelId,
  DeviceInstanceId,
  MountedDevice,
  ParamId,
  ProjectSnapshot,
  Seconds,
} from "../../types";
import type { GraphDescription, GraphNodeRef, GraphPatch, UtilNodeSpec } from "../../types/graph";
import type { AppDeviceHost } from "../../devices/harness";
import { dbToGain } from "../../devices/harness";
import type { AppParamRegistry } from "../../params";
import { p } from "../../params/descriptors";
import { withParamId } from "../../params";
import { audibleChannels } from "./audible";
import { buildGraph } from "./build";
import { diffGraph } from "./diff";
import { channelUtilRef, parseNodeRef, sendRef } from "./ids";

/** SS6: "~8 ms gain ramps at touched boundaries". */
export const REWIRE_RAMP_SECONDS = 0.008;
/** Wall-clock wait covering the dip before the actual rewire. */
export const REWIRE_WAIT_MS = 12;

/** Mixer fader range, in dB. -60 renders as -inf and maps to gain 0. */
export const VOLUME_MIN_DB = -60;
export const VOLUME_MAX_DB = 6;

const EMPTY_GRAPH: GraphDescription = { utils: new Map(), mounts: new Map(), edges: new Map() };

export interface GraphReconcilerOptions {
  ctx: BaseAudioContext;
  destination: AudioNode;
  host: AppDeviceHost;
  params: AppParamRegistry;
  /**
   * Apply patches with no wall-clock dip phase. Defaults to `true` exactly
   * when waiting is meaningless: offline render, tests, fakes. The live app
   * passes `false` explicitly.
   */
  immediate?: boolean | undefined;
  /** Injectable wait (tests). Milliseconds. */
  wait?: ((ms: number) => Promise<void>) | undefined;
}

export interface GraphReconciler {
  /** Diffs against the last applied document and patches the live graph. */
  apply(doc: ProjectSnapshot): Promise<void>;
  /** The mounted instrument/effect behind a device id, if live. */
  mountedDevice(deviceId: DeviceInstanceId): MountedDevice | undefined;
  /** The channel's post-fader node — the SS6 meter tap. */
  meterTapFor(channelId: ChannelId): AudioNode | undefined;
  dispose(): void;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGraphReconciler(options: GraphReconcilerOptions): GraphReconciler {
  const { ctx, destination, host, params } = options;
  const immediate = options.immediate ?? true;
  const wait = options.wait ?? defaultWait;

  let live: GraphDescription = EMPTY_GRAPH;
  const utilNodes = new Map<GraphNodeRef, AudioNode>();
  const mixerParamIds = new Set<ParamId>();
  let disposed = false;

  // --- node resolution -------------------------------------------------------

  function resolveNode(ref: GraphNodeRef): AudioNode | undefined {
    if (ref === "$destination") return destination;
    const util = utilNodes.get(ref);
    if (util !== undefined) return util;
    const parsed = parseNodeRef(ref);
    if (parsed === null || parsed.kind !== "devicePort") return undefined;
    const mounted = host.get(parsed.deviceId);
    if (mounted === undefined) return undefined;
    if (parsed.port === "in") return mounted.input;
    if (parsed.port === "out") return mounted.output;
    return mounted.io.inputs[parsed.port];
  }

  function createUtil(spec: UtilNodeSpec): void {
    if (utilNodes.has(spec.ref)) return;
    const node = spec.type === "panner" ? ctx.createStereoPanner() : ctx.createGain();
    utilNodes.set(spec.ref, node);
  }

  // --- mixer params ----------------------------------------------------------

  const smoothGainWrite =
    (gain: GainNode, floorDb: number) =>
    (v: number, when: Seconds): void => {
      const at = Math.max(when, ctx.currentTime);
      gain.gain.setTargetAtTime(dbToGain(v, floorDb), at, 0.005);
    };

  /** Registers + binds vol/pan/send params for the channels in `doc`, and
   *  unregisters what no longer exists. Device params are the harness's job. */
  function syncMixerParams(doc: ProjectSnapshot): void {
    const wanted = new Map<ParamId, () => void>();

    for (const channelId of doc.channelOrder) {
      const channel = doc.channels[channelId];
      if (channel === undefined) continue;
      const vol = utilNodes.get(channelUtilRef(channelId, "vol"));
      const pan = utilNodes.get(channelUtilRef(channelId, "pan"));
      if (vol !== undefined) {
        wanted.set(channel.volume, () => {
          const handle = params.register(
            withParamId(
              p.db("vol", "Volume", { min: VOLUME_MIN_DB, max: VOLUME_MAX_DB, default: 0 }),
              channel.volume,
            ),
          );
          handle.bindMessage(smoothGainWrite(vol as GainNode, VOLUME_MIN_DB));
        });
      }
      if (pan !== undefined) {
        wanted.set(channel.pan, () => {
          const handle = params.register(withParamId(p.pan("pan"), channel.pan));
          handle.bindAudioParam((pan as StereoPannerNode).pan);
        });
      }
      for (const send of channel.sends) {
        const gain = utilNodes.get(sendRef(channelId, send.to));
        if (gain === undefined) continue;
        wanted.set(send.amount, () => {
          const handle = params.register(
            withParamId(
              p.db("send", "Send", { min: VOLUME_MIN_DB, max: VOLUME_MAX_DB, default: VOLUME_MIN_DB }),
              send.amount,
            ),
          );
          handle.bindMessage(smoothGainWrite(gain as GainNode, VOLUME_MIN_DB));
        });
      }
    }

    for (const id of [...mixerParamIds]) {
      if (!wanted.has(id)) {
        params.unregister(id);
        mixerParamIds.delete(id);
      }
    }
    for (const [id, register] of wanted) {
      if (!mixerParamIds.has(id)) {
        register();
        mixerParamIds.add(id);
      }
    }
  }

  // --- solo-in-place ---------------------------------------------------------

  function applyMutes(doc: ProjectSnapshot): void {
    const audible = audibleChannels(doc);
    const now = ctx.currentTime;
    for (const channelId of doc.channelOrder) {
      const mute = utilNodes.get(channelUtilRef(channelId, "mute"));
      if (mute === undefined) continue;
      const target = audible.has(channelId) ? 1 : 0;
      (mute as GainNode).gain.setTargetAtTime(target, now, 0.005);
    }
  }

  // --- click-free rewires ----------------------------------------------------

  /** Structural unity gains touched by the patch — the boundaries to dip.
   *  vol/pan/send stay param-driven and mute stays audibility-driven. */
  function touchedBoundaryGains(patch: GraphPatch): GainNode[] {
    const touched = new Set<GraphNodeRef>();
    const note = (ref: GraphNodeRef): void => {
      const parsed = parseNodeRef(ref);
      if (parsed === null || parsed.kind !== "util") return;
      if (parsed.util === "input" || parsed.util === "postfx" || parsed.util === "post") {
        touched.add(ref);
      }
    };
    for (const e of patch.disconnect) {
      note(e.from);
      note(e.to);
    }
    for (const e of patch.connect) {
      note(e.from);
      note(e.to);
    }
    const out: GainNode[] = [];
    for (const ref of touched) {
      const node = utilNodes.get(ref);
      // Only PRE-EXISTING nodes need the dip; a node created by this very
      // patch has no signal running through it yet.
      if (node !== undefined && live.utils.has(ref)) out.push(node as GainNode);
    }
    return out;
  }

  // --- patch application -----------------------------------------------------

  async function applyPatch(patch: GraphPatch): Promise<void> {
    for (const spec of patch.createUtils) createUtil(spec);

    for (const spec of patch.mountDevices) {
      const definition = host.registry.get(spec.definitionId);
      if (definition === undefined) continue; // unknown id: stays silent, doc intact
      if (host.get(spec.deviceId) !== undefined) host.unmount(spec.deviceId);
      await host.mount({ definition, instanceId: spec.deviceId, channelId: spec.channelId });
      if (disposed) return;
    }

    const rewires = patch.disconnect.length > 0 || patch.connect.length > 0;
    const dipped = rewires && !immediate ? touchedBoundaryGains(patch) : [];
    if (dipped.length > 0) {
      const now = ctx.currentTime;
      for (const gain of dipped) gain.gain.setTargetAtTime(0, now, REWIRE_RAMP_SECONDS / 4);
      await wait(REWIRE_WAIT_MS);
      if (disposed) return;
    }

    for (const edge of patch.disconnect) {
      const from = resolveNode(edge.from);
      const to = resolveNode(edge.to);
      if (from === undefined || to === undefined) continue;
      try {
        from.disconnect(to);
      } catch {
        // Already gone (its device unmounted first) — fine.
      }
    }
    for (const edge of patch.connect) {
      const from = resolveNode(edge.from);
      const to = resolveNode(edge.to);
      if (from === undefined || to === undefined) continue;
      from.connect(to);
    }

    if (dipped.length > 0) {
      const now = ctx.currentTime;
      for (const gain of dipped) gain.gain.setTargetAtTime(1, now, REWIRE_RAMP_SECONDS / 4);
    }

    for (const deviceId of patch.unmountDevices) host.unmount(deviceId);
    for (const ref of patch.disposeUtils) {
      const node = utilNodes.get(ref);
      if (node !== undefined) {
        try {
          node.disconnect();
        } catch {
          // Node had no connections left.
        }
        utilNodes.delete(ref);
      }
    }
  }

  return {
    async apply(doc: ProjectSnapshot): Promise<void> {
      if (disposed) return;
      const desired = buildGraph(doc);
      const patch = diffGraph(live, desired);
      await applyPatch(patch);
      if (disposed) return;
      live = desired;
      // New util gains start at 1 (GainNode default), which is right for
      // every structural gain; send/vol/pan values arrive via param binds
      // below, and mutes via the audible set.
      syncMixerParams(doc);
      applyMutes(doc);
    },

    mountedDevice(deviceId: DeviceInstanceId): MountedDevice | undefined {
      return host.get(deviceId);
    },

    meterTapFor(channelId: ChannelId): AudioNode | undefined {
      return utilNodes.get(channelUtilRef(channelId, "post"));
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const id of mixerParamIds) params.unregister(id);
      mixerParamIds.clear();
      for (const node of utilNodes.values()) {
        try {
          node.disconnect();
        } catch {
          // Already detached.
        }
      }
      utilNodes.clear();
      live = EMPTY_GRAPH;
    },
  };
}
