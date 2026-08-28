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
//   - dip the SOURCE side of every changed edge ~8 ms around a rewire so
//     chain reorders / swaps / regrouping are click-free (SS6 "Reconciler").
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
import { MACRO_MAX, MACRO_MIN } from "../../types";
import { audibleChains, audibleChannels } from "./audible";
import { buildGraph } from "./build";
import { diffGraph } from "./diff";
import { channelUtilRef, parseNodeRef, rackChainUtilRef, sendRef } from "./ids";

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
  /**
   * The live node behind a graph ref (`channelUtilRef`, `sendRef`). The
   * reconciler owns every utility node, so this is the only way anything
   * else — diagnostics, and the tests that assert on the mute gains
   * solo-in-place writes — can name one by identity instead of scanning
   * every gain the context ever handed out. Read-only by convention:
   * nothing outside this file connects or schedules on these.
   */
  nodeFor(ref: GraphNodeRef): AudioNode | undefined;
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
  /** The last mute-gain target written per channel. `applyMutes` runs on EVERY
   *  document edit, so without this every note edit re-schedules a ramp on
   *  every channel's mute gain, and a mute gain seeded at creation would be
   *  immediately re-ramped to the value it already holds. Cleared with the
   *  node it describes. */
  const muteTargets = new Map<GraphNodeRef, number>();
  const mixerParamIds = new Set<ParamId>();
  /**
   * SS7 macros: macro ParamId -> its current targets.
   *
   * The map is re-read by the macro's BINDING on every write, rather than
   * captured when the binding is made: re-mapping a macro changes only this
   * table, and re-registering the param on every mapping edit would drop the
   * handle the UI is holding mid-gesture.
   */
  const macroTargets = new Map<ParamId, readonly { paramId: ParamId; min: number; max: number }[]>();

  /**
   * Writes one macro's value out to its targets.
   *
   * Called from the macro's binding AND directly after every apply. It is not
   * routed through the handle in the second case on purpose: a handle skips a
   * push whose value has not changed (the de-dupe that keeps a knob from
   * re-writing the same number every frame), and re-applying a macro after a
   * re-map or a project load has exactly that shape — same value, different
   * targets.
   */
  function fanOutMacro(macroParam: ParamId, value: number): void {
    const targets = macroTargets.get(macroParam) ?? [];
    const fraction = (value - MACRO_MIN) / (MACRO_MAX - MACRO_MIN || 1);
    for (const target of targets) {
      const bound = params.get(target.paramId);
      // A target whose device is not mounted (or whose param was renamed)
      // simply has no handle — the mapping stays in the document, greyed,
      // exactly as SS7 treats an automation lane pointing at a removed
      // device.
      if (bound === undefined) continue;
      bound.setLive(target.min + fraction * (target.max - target.min), "user");
    }
  }
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

  /** Clamp to the fader range the param descriptor will enforce anyway, so a
   *  seeded node and its (later) param write agree exactly. */
  function clampDb(db: number): number {
    return Math.min(VOLUME_MAX_DB, Math.max(VOLUME_MIN_DB, db));
  }

  /**
   * The value a freshly created node must START at.
   *
   * A `GainNode` is born at 1.0 and a `StereoPannerNode` at 0, but a send is
   * born SILENT (-60 dB), a fader sits wherever the project saved it, and a
   * muted channel's mute gain is 0. Nothing corrects that in the same audio
   * instant: the param bind seeds through `smoothGainWrite`, and
   * `params.load(doc.paramValues)` only lands after the whole reconcile — so
   * a node left at its native default GLIDES in from 0 dB over the binding's
   * smoothing time. Live that is a wet blip into the return on every new
   * send; on the SS12 offline render it bakes the first ~30 ms of the WAV
   * with every send wide open and every fader sliding. Starting the node
   * where the document already says it is makes both later writes no-ops.
   *
   * Its partner is `seedBase` below: this puts the NODE at the document's
   * value (it carries signal from the moment the patch connects it, before
   * any param exists), that puts the HANDLE there (so the bind's own seed
   * write agrees instead of overwriting it with the descriptor default).
   */
  function seedUtilNode(
    node: AudioNode,
    spec: UtilNodeSpec,
    doc: ProjectSnapshot,
    audible: ReadonlySet<ChannelId>,
  ): void {
    // Rack chain nodes are addressed through the rack, not the channel.
    if (spec.rackId !== undefined && spec.chainId !== undefined) {
      const rack = doc.racks[spec.rackId];
      const chain = rack?.chains.find((c) => c.id === spec.chainId);
      if (chain === undefined) return;
      if (spec.kind === "chainGain") {
        (node as GainNode).gain.value = dbToGain(clampDb(doc.paramValues[chain.gain] ?? 0), VOLUME_MIN_DB);
      } else if (spec.kind === "chainPan") {
        (node as StereoPannerNode).pan.value = Math.min(1, Math.max(-1, doc.paramValues[chain.pan] ?? 0));
      } else if (spec.kind === "chainMute") {
        const open = audibleChains(rack?.chains ?? []).has(chain.id) ? 1 : 0;
        (node as GainNode).gain.value = open;
        muteTargets.set(spec.ref, open);
      }
      return;
    }
    const channel = doc.channels[spec.channelId];
    if (channel === undefined) return;
    if (spec.kind === "vol") {
      (node as GainNode).gain.value = dbToGain(clampDb(doc.paramValues[channel.volume] ?? 0), VOLUME_MIN_DB);
    } else if (spec.kind === "send" && spec.sendTo !== undefined) {
      const send = channel.sends.find((s) => s.to === spec.sendTo);
      const db = send === undefined ? VOLUME_MIN_DB : (doc.paramValues[send.amount] ?? VOLUME_MIN_DB);
      (node as GainNode).gain.value = dbToGain(clampDb(db), VOLUME_MIN_DB);
    } else if (spec.kind === "mute") {
      const open = audible.has(spec.channelId) ? 1 : 0;
      (node as GainNode).gain.value = open;
      muteTargets.set(spec.ref, open);
    } else if (spec.kind === "pan") {
      const value = doc.paramValues[channel.pan] ?? 0;
      (node as StereoPannerNode).pan.value = Math.min(1, Math.max(-1, value));
    }
  }

  function createUtil(spec: UtilNodeSpec, doc: ProjectSnapshot, audible: ReadonlySet<ChannelId>): void {
    if (utilNodes.has(spec.ref)) return;
    const node = spec.type === "panner" ? ctx.createStereoPanner() : ctx.createGain();
    seedUtilNode(node, spec, doc, audible);
    utilNodes.set(spec.ref, node);
  }

  // --- mixer params ----------------------------------------------------------

  /**
   * dB param -> gain node, de-zippered. The FIRST call after a bind is the
   * handle's seed (`bindMessage` pushes the current value immediately, the
   * message-path counterpart of fast path A's `immediate` write), and it must
   * JUMP: a `setTargetAtTime` seed glides over ~20 ms from wherever the node
   * happens to be, which is exactly the artefact `seedUtilNode` exists to
   * avoid. Every later call is a knob or automation write and keeps the
   * short target ramp.
   */
  /**
   * The message path's cancel primitive for a mixer gain (SS11). A window of
   * automation writes is queued a whole look-ahead ahead; when the user grabs
   * the fader mid-playback, the handle calls this to revoke the tail before
   * writing the hand's value, so the gain does not warble between the lane
   * and the hand until the queue drains. `bindAudioParam` gets the same
   * guarantee for free through `cancelAndHoldAtTime`; a message binding only
   * has it if the binder supplies one (`BindMessageOptions.cancelFrom`).
   */
  const cancelGainWrites =
    (gain: GainNode) =>
    (when: Seconds): void => {
      gain.gain.cancelScheduledValues(Math.max(when, ctx.currentTime));
    };

  const smoothGainWrite = (gain: GainNode, floorDb: number) => {
    let seeded = false;
    return (v: number, when: Seconds): void => {
      const at = Math.max(when, ctx.currentTime);
      const target = dbToGain(v, floorDb);
      if (!seeded) {
        seeded = true;
        gain.gain.setValueAtTime(target, at);
        return;
      }
      gain.gain.setTargetAtTime(target, at, 0.005);
    };
  };

  /**
   * A freshly registered handle starts at its DESCRIPTOR default, and
   * binding seeds the node with whatever the handle holds at that moment —
   * while the document's saved value only arrives later, when the app calls
   * `params.load(doc.paramValues)` after the whole reconcile. Without this,
   * every bind writes 0 dB first and the fader then slides to its real value
   * over the de-zipper time: audible on load, and baked into the head of an
   * offline render (SS12). Seeding the base before the bind makes the bind's
   * own write the right one, and `load`'s later write a no-op.
   */
  function seedBase(handle: { setBase(value: number): void }, doc: ProjectSnapshot, id: ParamId): void {
    const saved = doc.paramValues[id];
    if (saved !== undefined) handle.setBase(saved);
  }

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
          seedBase(handle, doc, channel.volume);
          handle.bindMessage(smoothGainWrite(vol as GainNode, VOLUME_MIN_DB), {
            cancelFrom: cancelGainWrites(vol as GainNode),
          });
        });
      }
      if (pan !== undefined) {
        wanted.set(channel.pan, () => {
          const handle = params.register(withParamId(p.pan("pan"), channel.pan));
          seedBase(handle, doc, channel.pan);
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
          seedBase(handle, doc, send.amount);
          handle.bindMessage(smoothGainWrite(gain as GainNode, VOLUME_MIN_DB), {
            cancelFrom: cancelGainWrites(gain as GainNode),
          });
        });
      }
    }

    // SS7 racks: a chain's gain/pan are ordinary registry params on the
    // hosting channel's path, so they automate, undo and save with no
    // special case — the only new thing is which node they drive.
    for (const rack of Object.values(doc.racks)) {
      for (const chain of rack.chains) {
        const gain = utilNodes.get(rackChainUtilRef(rack.id, chain.id, "gain"));
        const pan = utilNodes.get(rackChainUtilRef(rack.id, chain.id, "pan"));
        if (gain !== undefined) {
          wanted.set(chain.gain, () => {
            const handle = params.register(
              withParamId(
                p.db("gain", "Chain Gain", { min: VOLUME_MIN_DB, max: VOLUME_MAX_DB, default: 0 }),
                chain.gain,
              ),
            );
            seedBase(handle, doc, chain.gain);
            handle.bindMessage(smoothGainWrite(gain as GainNode, VOLUME_MIN_DB), {
              cancelFrom: cancelGainWrites(gain as GainNode),
            });
          });
        }
        if (pan !== undefined) {
          wanted.set(chain.pan, () => {
            const handle = params.register(withParamId(p.pan("pan"), chain.pan));
            seedBase(handle, doc, chain.pan);
            handle.bindAudioParam((pan as StereoPannerNode).pan);
          });
        }
      }
    }

    // SS7 macros. The macro itself is an ordinary registry param (so it
    // automates, undoes and saves); the FAN-OUT is engine behaviour, written
    // on the LIVE path only. Target values are therefore derived, never
    // stored: what the document keeps is the macro's own value, and
    // re-applying it after a load or an undo puts every target back.
    macroTargets.clear();
    for (const rack of Object.values(doc.racks)) {
      for (const macro of rack.macros) {
        macroTargets.set(
          macro.param,
          macro.targets.map((t) => ({ paramId: t.paramId, min: t.min, max: t.max })),
        );
        wanted.set(macro.param, () => {
          const handle = params.register(
            withParamId(
              p.continuous("macro", "Macro", { min: MACRO_MIN, max: MACRO_MAX, default: 0 }),
              macro.param,
            ),
          );
          seedBase(handle, doc, macro.param);
          handle.bindMessage((value) => fanOutMacro(macro.param, value));
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

    // Re-assert every macro AFTER registration: its targets are derived
    // values, so a project load, an undo, or a newly mounted device inside
    // the rack must be re-driven from the macro's own value rather than left
    // wherever the target's stale document value put it.
    for (const [macroParam] of macroTargets) {
      const handle = params.get(macroParam);
      if (handle !== undefined) fanOutMacro(macroParam, handle.live());
    }
  }

  // --- solo-in-place ---------------------------------------------------------

  function applyMutes(audible: ReadonlySet<ChannelId>, doc: ProjectSnapshot): void {
    const now = ctx.currentTime;
    for (const channelId of doc.channelOrder) {
      const ref = channelUtilRef(channelId, "mute");
      const mute = utilNodes.get(ref);
      if (mute === undefined) continue;
      const target = audible.has(channelId) ? 1 : 0;
      if (muteTargets.get(ref) === target) continue; // already there — say nothing
      muteTargets.set(ref, target);
      (mute as GainNode).gain.setTargetAtTime(target, now, 0.005);
    }
    // Chain solo/mute inside every rack — same trick, rack-local scope.
    for (const rack of Object.values(doc.racks)) {
      const open = audibleChains(rack.chains);
      for (const chain of rack.chains) {
        const ref = rackChainUtilRef(rack.id, chain.id, "mute");
        const node = utilNodes.get(ref);
        if (node === undefined) continue;
        const target = open.has(chain.id) ? 1 : 0;
        if (muteTargets.get(ref) === target) continue;
        muteTargets.set(ref, target);
        (node as GainNode).gain.setTargetAtTime(target, now, 0.005);
      }
    }
  }

  // --- click-free rewires ----------------------------------------------------

  /** Which channel owns a device this patch mentions — `live.mounts` for one
   *  already running, `patch.mountDevices` for one arriving in this patch. */
  function channelOfDevice(deviceId: DeviceInstanceId, patch: GraphPatch): ChannelId | undefined {
    const mounted = live.mounts.get(deviceId);
    if (mounted !== undefined) return mounted.channelId;
    return patch.mountDevices.find((spec) => spec.deviceId === deviceId)?.channelId;
  }

  /**
   * Structural unity gains touched by the patch — the boundaries to dip.
   *
   * SOURCE side only. A changed edge's DESTINATION is very often a shared
   * summing point: `chan:master/input` is the destination of every track's
   * output edge, so dipping destinations drops the WHOLE mix for the length
   * of the dip whenever an unrelated, empty track is added or re-routed.
   * Dipping the source is sufficient — the signal about to be re-routed is
   * the only one that can step — and it touches nothing else.
   *
   * vol/pan/send stay param-driven and mute stays audibility-driven, so the
   * dip set is the structural unity gains only. A device port has no gain of
   * its own, so an intra-chain rewire (`dev:A/out -> dev:B/in`, i.e. every
   * chain reorder and every enable toggle in the middle of a chain) dips the
   * owning channel's `postfx` instead: the chain's tail, downstream of every
   * device in it, and the one node that covers the discontinuity regardless
   * of where in the chain it happens.
   */
  function touchedBoundaryGains(patch: GraphPatch): GainNode[] {
    const touched = new Set<GraphNodeRef>();
    const note = (ref: GraphNodeRef): void => {
      const parsed = parseNodeRef(ref);
      if (parsed === null) return;
      if (parsed.kind === "util") {
        if (parsed.util === "input" || parsed.util === "postfx" || parsed.util === "post") {
          touched.add(ref);
        }
        return;
      }
      if (parsed.kind !== "devicePort") return;
      const channelId = channelOfDevice(parsed.deviceId, patch);
      if (channelId !== undefined) touched.add(channelUtilRef(channelId, "postfx"));
    };
    for (const e of patch.disconnect) note(e.from);
    for (const e of patch.connect) note(e.from);

    const out: GainNode[] = [];
    for (const ref of touched) {
      const node = utilNodes.get(ref);
      // Only PRE-EXISTING nodes need the dip; a node created by this very
      // patch has no signal running through it yet.
      if (node !== undefined && live.utils.has(ref)) out.push(node as GainNode);
    }
    return out;
  }

  // --- routing news for devices (SS6 -> SS7) ---------------------------------

  /** What each device port was last told, so a re-apply that changes nothing
   *  says nothing. Keyed `<deviceId>/<portId>`; entries die with the mount. */
  const portRouting = new Map<string, boolean>();
  /** Device id -> the settings that device has already been told about. */
  const deviceSettings = new Map<DeviceInstanceId, Map<string, string>>();

  /**
   * A device cannot see its own incoming connections, and the harness gives it
   * a port node whether or not the document ever feeds it — so an optional
   * input (the compressor's `sc` key) is indistinguishable from a routed one
   * that happens to be silent. This is the reconciler telling it, because the
   * reconciler is the only code that knows: the SS6 edge is document data.
   *
   * Computed from the WHOLE desired graph rather than from the patch, so a
   * device that mounts with its sidechain already wired is told at mount, and
   * a port fed by two sources stays routed when only one goes away.
   */
  /**
   * Pushes `DeviceState.settings` into the live devices (SS7 non-numeric
   * state — the sampler's chosen file).
   *
   * Same shape as `syncPortRouting` and for the same reason: a device cannot
   * read the document, so the reconciler — the only code that sees both —
   * tells it. Diffed against what each device was last told, so a device is
   * told once per actual change rather than once per apply (and every apply
   * is every knob release, every note drag).
   *
   * A device REMOUNTED under the same id is told from scratch: `applyPatch`
   * clears its row here when it unmounts, so a swap does not inherit the
   * previous instance's memory of what it had been told.
   */
  function syncDeviceSettings(doc: ProjectSnapshot): void {
    for (const deviceId of Object.keys(doc.devices)) {
      const mounted = host.get(deviceId);
      if (mounted === undefined || typeof mounted.instance.setSetting !== "function") continue;
      const settings = doc.devices[deviceId]?.settings ?? {};
      let told = deviceSettings.get(deviceId);
      if (told === undefined) {
        told = new Map<string, string>();
        deviceSettings.set(deviceId, told);
      }
      for (const key of Object.keys(settings)) {
        const value = settings[key] ?? "";
        if (told.get(key) === value) continue;
        told.set(key, value);
        mounted.instance.setSetting(key, value);
      }
      for (const key of [...told.keys()]) {
        if (key in settings) continue;
        told.delete(key);
        mounted.instance.setSetting(key, null);
      }
    }
    for (const deviceId of [...deviceSettings.keys()]) {
      if (host.get(deviceId) === undefined) deviceSettings.delete(deviceId);
    }
  }

  function syncPortRouting(desired: GraphDescription): void {
    const fed = new Set<string>();
    for (const edge of desired.edges.values()) {
      const parsed = parseNodeRef(edge.to);
      if (parsed === null || parsed.kind !== "devicePort" || parsed.port === "in") continue;
      fed.add(`${parsed.deviceId}/${parsed.port}`);
    }
    for (const deviceId of desired.mounts.keys()) {
      const mounted = host.get(deviceId);
      if (mounted === undefined || typeof mounted.instance.portRouted !== "function") continue;
      for (const portId of Object.keys(mounted.io.inputs)) {
        if (portId === "in") continue;
        const key = `${deviceId}/${portId}`;
        const routed = fed.has(key);
        if (portRouting.get(key) === routed) continue;
        portRouting.set(key, routed);
        mounted.instance.portRouted(portId, routed);
      }
    }
    // Forget the ports of devices that are no longer mounted, so a remount
    // with the same id is told again from scratch.
    for (const key of [...portRouting.keys()]) {
      const deviceId = key.slice(0, key.lastIndexOf("/"));
      if (!desired.mounts.has(deviceId) || host.get(deviceId) === undefined) {
        portRouting.delete(key);
      }
    }
  }

  // --- patch application -----------------------------------------------------

  async function applyPatch(
    patch: GraphPatch,
    doc: ProjectSnapshot,
    audible: ReadonlySet<ChannelId>,
  ): Promise<void> {
    for (const spec of patch.createUtils) createUtil(spec, doc, audible);

    // Ids this patch (re)mounted — see the `unmountDevices` loop below.
    const remounted = new Set<DeviceInstanceId>();
    for (const spec of patch.mountDevices) {
      const definition = host.registry.get(spec.definitionId);
      if (definition === undefined) continue; // unknown id: stays silent, doc intact
      if (host.get(spec.deviceId) !== undefined) host.unmount(spec.deviceId);
      await host.mount({ definition, instanceId: spec.deviceId, channelId: spec.channelId });
      remounted.add(spec.deviceId);
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

    // A REPLACE — same instance id, new `definitionId` or `channelId` — is
    // BOTH a mount and an unmount in the patch (diff.ts), and the mount loop
    // above already tore the stale instance down before remounting. Running
    // the unmount as well would dispose the device just mounted and leave the
    // chain's edges pointing at a dead node, silencing the channel for the
    // rest of the session. Only unmount what this patch did not remount.
    for (const deviceId of patch.unmountDevices) {
      if (!remounted.has(deviceId)) host.unmount(deviceId);
    }
    for (const ref of patch.disposeUtils) {
      const node = utilNodes.get(ref);
      if (node !== undefined) {
        try {
          node.disconnect();
        } catch {
          // Node had no connections left.
        }
        utilNodes.delete(ref);
        muteTargets.delete(ref);
      }
    }
  }

  return {
    async apply(doc: ProjectSnapshot): Promise<void> {
      if (disposed) return;
      const desired = buildGraph(doc);
      const patch = diffGraph(live, desired);
      // Solo-in-place is computed once: `createUtil` seeds a new channel's
      // mute gain from it (a channel born muted must not fade in), and
      // `applyMutes` writes the whole set below.
      const audible = audibleChannels(doc);
      await applyPatch(patch, doc, audible);
      if (disposed) return;
      live = desired;
      // After the edges are real: the device learns whether its optional
      // input ports are actually fed (SS6 sidechain -> SS7 device).
      syncPortRouting(desired);
      // ...and what its non-numeric document state says (SS7 settings).
      syncDeviceSettings(doc);
      // Structural gains (input/postfx/post) keep the GainNode default of 1;
      // vol/pan/send/mute were seeded from the document at creation and are
      // driven from here on by the param binds and the audible set.
      syncMixerParams(doc);
      applyMutes(audible, doc);
    },

    mountedDevice(deviceId: DeviceInstanceId): MountedDevice | undefined {
      return host.get(deviceId);
    },

    meterTapFor(channelId: ChannelId): AudioNode | undefined {
      return utilNodes.get(channelUtilRef(channelId, "post"));
    },

    nodeFor(ref: GraphNodeRef): AudioNode | undefined {
      return utilNodes.get(ref);
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
      muteTargets.clear();
      live = EMPTY_GRAPH;
    },
  };
}
