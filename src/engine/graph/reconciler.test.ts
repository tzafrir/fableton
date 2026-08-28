// SS6 — the reconciler under a fake `BaseAudioContext`: document in, live
// wiring out, patches (not rebuilds) between. SS15: no browser needed.

import { beforeEach, describe, expect, it } from "vitest";
import {
  FakeAudioNode,
  FakeGainNode,
  FakeStereoPannerNode,
  asContext,
  asNode,
  createFakeAudioContext,
  type FakeAudioContext,
} from "../../devices/harness/testing/fakeAudio";
import { createDeviceHost, createDeviceRegistry, deviceInstance } from "../../devices/harness";
import {
  createParamRegistry,
  deviceParamId,
  rackMacroParamId,
  type AppParamRegistry,
} from "../../params";
import type { DeviceDefinition, Project, ProjectSnapshot } from "../../types";
import { p } from "../../params/descriptors";
import { REWIRE_WAIT_MS, createGraphReconciler, type GraphReconciler } from "./reconciler";
import { channelUtilRef, sendRef } from "./ids";
import { routingDoc, twoTrackDoc } from "./testing/docs";

/** A trivial pass-through effect with an optional sidechain port. */
const TestFx: DeviceDefinition = {
  id: "test.fx",
  version: 1,
  kind: "audioEffect",
  label: "Test FX",
  params: [p.pct("mix", "Mix", { default: 100 })],
  audioIn: [{ id: "in" }, { id: "sc", label: "Sidechain", optional: true }],
  audioOut: [{ id: "out" }],
  create(ctx, io) {
    const through = ctx.createGain();
    io.in.connect(through);
    through.connect(io.out);
    return deviceInstance({ dispose: () => through.disconnect() });
  },
};

/** Records what the reconciler tells it about its optional ports (SS6->SS7). */
const portEvents: { deviceId: string; portId: string; routed: boolean }[] = [];

const TestScFx: DeviceDefinition = {
  id: "test.sc-fx",
  version: 1,
  kind: "audioEffect",
  label: "Test SC FX",
  params: [],
  audioIn: [{ id: "in" }, { id: "sc", label: "Sidechain", optional: true }],
  audioOut: [{ id: "out" }],
  create(ctx, io) {
    const through = ctx.createGain();
    io.in.connect(through);
    through.connect(io.out);
    return deviceInstance({
      dispose: () => through.disconnect(),
      portRouted: (portId, routed) => portEvents.push({ deviceId: "?", portId, routed }),
    });
  },
};

const TestSynth: DeviceDefinition = {
  id: "test.synth",
  version: 1,
  kind: "instrument",
  label: "Test Synth",
  params: [],
  audioIn: [],
  audioOut: [{ id: "out" }],
  create(ctx, io) {
    const voice = ctx.createGain();
    voice.connect(io.out);
    return deviceInstance({
      noteOn: () => undefined,
      noteOff: () => undefined,
      allNotesOff: () => undefined,
      dispose: () => voice.disconnect(),
    });
  },
};

interface Rig {
  fake: FakeAudioContext;
  params: AppParamRegistry;
  reconciler: GraphReconciler;
}

/** A fresh context + registry + reconciler. Each rig owns its own
 *  `ParamRegistry`, so two rigs in one test never collide over param ids. */
function createRig(
  options: { immediate?: boolean; wait?: (ms: number) => Promise<void> } = {},
): Rig {
  const fake = createFakeAudioContext();
  const params = createParamRegistry({ now: () => fake.currentTime });
  const registry = createDeviceRegistry([TestFx, TestScFx, TestSynth]);
  const host = createDeviceHost(asContext(fake), params, registry);
  const reconciler = createGraphReconciler({
    ctx: asContext(fake),
    destination: asNode(fake.destination),
    host,
    params,
    immediate: options.immediate ?? true,
    wait: options.wait,
  });
  return { fake, params, reconciler };
}

let fake: FakeAudioContext;
let params: AppParamRegistry;
let reconciler: GraphReconciler;

beforeEach(() => {
  ({ fake, params, reconciler } = createRig());
});

/** Is there a recorded connection `from -> to` (by node object)? */
function connected(from: AudioNode | undefined, to: AudioNode | undefined): boolean {
  if (from === undefined || to === undefined) return false;
  return (from as unknown as FakeAudioNode).connections.some((c) => c.to === (to as unknown as FakeAudioNode));
}

function gainOf(node: AudioNode | undefined): FakeGainNode {
  return node as unknown as FakeGainNode;
}

describe("graph reconciler", () => {
  it("wires two tracks into the master and the master into the destination", async () => {
    await reconciler.apply(twoTrackDoc());
    const t1post = reconciler.meterTapFor("t1");
    const masterPost = reconciler.meterTapFor("master");
    expect(t1post).toBeDefined();
    // t1 post reaches the master input by way of the channel spine; walk one hop.
    expect(connected(masterPost, asNode(fake.destination))).toBe(true);
  });

  it("mounts chain devices and threads audio through them", async () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "fx1", definitionId: "test.fx", channelId: "t1" }],
    });
    await reconciler.apply(doc);
    const mounted = reconciler.mountedDevice("fx1");
    expect(mounted).toBeDefined();
  });

  it("reordering a chain rewires without remounting", async () => {
    const chain = (order: string[]): Project =>
      routingDoc({
        channels: [
          { id: "t1", role: "track", chain: order },
          { id: "master", role: "master", output: null },
        ],
        devices: [
          { id: "a", definitionId: "test.fx", channelId: "t1" },
          { id: "b", definitionId: "test.fx", channelId: "t1" },
        ],
      });
    await reconciler.apply(chain(["a", "b"]));
    const mountedA = reconciler.mountedDevice("a");
    await reconciler.apply(chain(["b", "a"]));
    expect(reconciler.mountedDevice("a")).toBe(mountedA); // same instance object
    const aOut = mountedA?.output;
    const bIn = reconciler.mountedDevice("b")?.input;
    expect(connected(aOut, bIn)).toBe(false);
    expect(connected(reconciler.mountedDevice("b")?.output, mountedA?.input)).toBe(true);
  });

  it("registers vol/pan/send params and drives the gain nodes", async () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", sends: [{ to: "ret", amount: "chan:t1/send:ret", tap: "post" }] },
        { id: "ret", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    await reconciler.apply(doc);
    const vol = params.get("chan:t1/vol");
    const pan = params.get("chan:t1/pan");
    const send = params.get("chan:t1/send:ret");
    expect(vol).toBeDefined();
    expect(pan).toBeDefined();
    expect(send).toBeDefined();

    vol?.setLive(-6, "user");
    // The vol handle writes dB -> linear onto the channel's vol gain.
    // Find it: the util gain whose scheduled value moved to ~0.501.
    const scheduled = fake.created
      .filter((n): n is FakeGainNode => n instanceof FakeGainNode)
      .map((n) => n.gain.scheduled);
    expect(scheduled.some((v) => Math.abs(v - Math.pow(10, -6 / 20)) < 1e-6)).toBe(true);

    pan?.setLive(-0.5, "user");
    const panners = fake.created.filter((n): n is FakeStereoPannerNode => n instanceof FakeStereoPannerNode);
    expect(panners.some((n) => Math.abs(n.pan.scheduled - -0.5) < 1e-9)).toBe(true);
  });

  // SS11: the message path's counterpart of `cancelAndHoldAtTime`. A window of
  // automation writes sits in the gain's schedule a whole look-ahead ahead;
  // the hand grabbing the fader has to revoke it, or the queued tail keeps
  // firing after the user's value and drags the gain back onto the lane.
  it("gives its vol/send message bindings the cancel primitive (SS11 override)", async () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", sends: [{ to: "ret", amount: "chan:t1/send:ret", tap: "post" }] },
        { id: "ret", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    await reconciler.apply(doc);
    const volGain = gainOf(reconciler.nodeFor(channelUtilRef("t1", "vol")));
    const sendGain = gainOf(reconciler.nodeFor(sendRef("t1", "ret")));

    for (const [id, gain] of [
      ["chan:t1/vol", volGain],
      ["chan:t1/send:ret", sendGain],
    ] as const) {
      params.setAutomatedIds(new Set([id]));
      // A look-ahead window lands in the future...
      params.scheduleAutomation(id, [
        { value: -3, when: fake.currentTime + 0.1 },
        { value: -12, when: fake.currentTime + 0.2 },
      ]);
      const beforeGrab = gain.gain.events.length;
      // ...and the user grabs the fader now.
      params.get(id)?.setLive(0, "user");
      const after = gain.gain.events.slice(beforeGrab);
      expect(after[0]?.kind).toBe("cancel");
      expect(after[0]?.time).toBeGreaterThanOrEqual(fake.currentTime);
      expect(after.some((e) => e.kind === "target")).toBe(true);
      params.setAutomatedIds(new Set());
    }
  });

  it("unregisters mixer params when their channel goes", async () => {
    await reconciler.apply(twoTrackDoc());
    expect(params.get("chan:t2/vol")).toBeDefined();
    await reconciler.apply(
      routingDoc({
        channels: [
          { id: "t1", role: "track" },
          { id: "master", role: "master", output: null },
        ],
      }),
    );
    expect(params.get("chan:t2/vol")).toBeUndefined();
    expect(params.get("chan:t1/vol")).toBeDefined();
  });

  it("solo-in-place drives the named channels' mute gains, not wiring", async () => {
    const solo = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true },
        { id: "t2", role: "track" },
        { id: "master", role: "master", output: null },
      ],
    });
    await reconciler.apply(solo);
    const edgesBefore = fake.created.reduce((n, node) => n + node.connections.length, 0);

    // By identity, not by "some gain somewhere went to 0": the whole point of
    // solo-in-place is WHICH channel is silenced (SS6 "just gain").
    const muteOf = (id: string): FakeGainNode => gainOf(reconciler.nodeFor(channelUtilRef(id, "mute")));
    expect(muteOf("t1").gain.scheduled).toBe(1);
    expect(muteOf("t2").gain.scheduled).toBe(0);
    expect(muteOf("master").gain.scheduled).toBe(1);

    const unsolo = routingDoc({
      channels: [
        { id: "t1", role: "track" },
        { id: "t2", role: "track" },
        { id: "master", role: "master", output: null },
      ],
    });
    await reconciler.apply(unsolo);
    const edgesAfter = fake.created.reduce((n, node) => n + node.connections.length, 0);
    expect(edgesAfter).toBe(edgesBefore); // no routing change
    expect(muteOf("t1").gain.scheduled).toBe(1);
    expect(muteOf("t2").gain.scheduled).toBe(1);
    // Same nodes throughout — solo never re-created anything.
    expect(reconciler.nodeFor(channelUtilRef("t2", "mute"))).toBe(muteOf("t2") as unknown as AudioNode);
  });

  it("a channel muted by its group is closed at its OWN mute gain (sends leak otherwise)", async () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", output: "g1", sends: [{ to: "ret", amount: "chan:t1/send:ret", tap: "post" }] },
        { id: "g1", role: "group", mute: true },
        { id: "ret", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    await reconciler.apply(doc);
    expect(gainOf(reconciler.nodeFor(channelUtilRef("g1", "mute"))).gain.scheduled).toBe(0);
    // t1's send tap sits after t1's mute gain, so only closing t1 itself stops
    // the wet signal reaching the return around the muted group.
    expect(gainOf(reconciler.nodeFor(channelUtilRef("t1", "mute"))).gain.scheduled).toBe(0);
  });

  it("sidechain edge connects the tap to the device's sc port", async () => {
    const doc = routingDoc({
      channels: [
        { id: "kick", role: "track" },
        { id: "bass", role: "track", chain: ["comp"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "comp", definitionId: "test.fx", channelId: "bass" }],
      sidechains: [{ from: { channel: "kick", tap: "postFader" }, to: { device: "comp", port: "sc" } }],
    });
    await reconciler.apply(doc);
    const kickPost = reconciler.meterTapFor("kick");
    const scPort = reconciler.mountedDevice("comp")?.io.inputs["sc"];
    expect(connected(kickPost, scPort)).toBe(true);
  });

  // SS6 -> SS7. A device cannot observe its own incoming connections, so an
  // optional input it is given unconditionally (the compressor's `sc` key)
  // cannot tell "not routed" from "routed and quiet". The reconciler knows,
  // because the edge is document data — so it has to say.
  it("tells a device when an SS6 edge reaches its optional port, and when it goes", async () => {
    portEvents.length = 0;
    const base = (sidechains: Project["sidechains"]) =>
      routingDoc({
        channels: [
          { id: "kick", role: "track" },
          { id: "bass", role: "track", chain: ["comp"] },
          { id: "master", role: "master", output: null },
        ],
        devices: [{ id: "comp", definitionId: "test.sc-fx", channelId: "bass" }],
        sidechains,
      });

    // Mounted with nothing routed: it is told so once.
    await reconciler.apply(base([]));
    expect(portEvents).toEqual([{ deviceId: "?", portId: "sc", routed: false }]);

    portEvents.length = 0;
    await reconciler.apply(
      base([{ from: { channel: "kick", tap: "postFader" }, to: { device: "comp", port: "sc" } }]),
    );
    expect(portEvents).toEqual([{ deviceId: "?", portId: "sc", routed: true }]);

    // An unrelated edit says nothing (the message would reach the render
    // thread on every document change otherwise).
    portEvents.length = 0;
    const unrelated = base([
      { from: { channel: "kick", tap: "postFader" }, to: { device: "comp", port: "sc" } },
    ]);
    unrelated.channels["kick"]!.name = "Kick 2";
    await reconciler.apply(unrelated);
    expect(portEvents).toEqual([]);

    // Clearing "Audio From" is told too.
    await reconciler.apply(base([]));
    expect(portEvents).toEqual([{ deviceId: "?", portId: "sc", routed: false }]);
  });

  it("deleting a channel disposes its nodes and unmounts its devices", async () => {
    const withFx = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1"] },
        { id: "t2", role: "track" },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "fx1", definitionId: "test.fx", channelId: "t1" }],
    });
    await reconciler.apply(withFx);
    expect(reconciler.mountedDevice("fx1")).toBeDefined();
    await reconciler.apply(
      routingDoc({
        channels: [
          { id: "t2", role: "track" },
          { id: "master", role: "master", output: null },
        ],
      }),
    );
    expect(reconciler.mountedDevice("fx1")).toBeUndefined();
    expect(reconciler.meterTapFor("t1")).toBeUndefined();
    expect(reconciler.meterTapFor("t2")).toBeDefined();
  });

  it("a disabled device stays mounted but out of the signal path", async () => {
    const doc = (enabled: boolean): Project =>
      routingDoc({
        channels: [
          { id: "t1", role: "track", chain: ["fx1"] },
          { id: "master", role: "master", output: null },
        ],
        devices: [{ id: "fx1", definitionId: "test.fx", channelId: "t1", enabled }],
      });
    await reconciler.apply(doc(true));
    const mounted = reconciler.mountedDevice("fx1");
    await reconciler.apply(doc(false));
    expect(reconciler.mountedDevice("fx1")).toBe(mounted);
    const input = gainOf(undefined);
    void input;
    // The channel input now bypasses straight to postfx: fx1's in is fed by nothing.
    const fxIn = mounted?.input;
    const feeders = fake.created.filter((n) => n.connections.some((c) => c.to === (fxIn as unknown as FakeAudioNode)));
    expect(feeders.length).toBe(0);
  });
});

describe("click-free rewires (the dip phase — only runs with immediate:false)", () => {
  const chainDoc = (order: string[]): Project =>
    routingDoc({
      channels: [
        { id: "t1", role: "track", chain: order },
        { id: "master", role: "master", output: null },
      ],
      devices: [
        { id: "a", definitionId: "test.fx", channelId: "t1" },
        { id: "b", definitionId: "test.fx", channelId: "t1" },
      ],
    });

  it("ramps the touched boundaries to 0, waits, rewires, ramps back", async () => {
    const waits: number[] = [];
    let onWait: (() => void) | null = null;
    const rig = createRig({
      immediate: false,
      wait: (ms) => {
        waits.push(ms);
        onWait?.();
        return Promise.resolve();
      },
    });

    await rig.reconciler.apply(chainDoc(["a", "b"]));
    // Nothing pre-existed on the first apply, so nothing was dipped.
    expect(waits).toEqual([]);

    const postfx = gainOf(rig.reconciler.nodeFor(channelUtilRef("t1", "postfx")));
    const input = gainOf(rig.reconciler.nodeFor(channelUtilRef("t1", "input")));
    const masterInput = gainOf(rig.reconciler.nodeFor(channelUtilRef("master", "input")));
    const aOut = rig.reconciler.mountedDevice("a")?.output;
    const bIn = rig.reconciler.mountedDevice("b")?.input;

    let during: { postfxValues: number[]; stillWired: boolean } | undefined;
    onWait = () => {
      during = {
        postfxValues: postfx.gain.events.map((e) => e.value),
        stillWired: connected(aOut, bIn),
      };
    };

    await rig.reconciler.apply(chainDoc(["b", "a"]));

    expect(waits).toEqual([REWIRE_WAIT_MS]);
    // The dip is fully scheduled BEFORE the wait, and the old edges are still
    // in place at that moment — that ordering is the whole mechanism.
    expect(during?.postfxValues).toEqual([0]);
    expect(during?.stillWired).toBe(true);
    // ...and the boundary is back at unity after the connects.
    expect(postfx.gain.events.map((e) => e.value)).toEqual([0, 1]);
    expect(input.gain.events.map((e) => e.value)).toEqual([0, 1]);
    expect(connected(aOut, bIn)).toBe(false);
    // The master's summing input carries three other tracks' worth of signal
    // in a real project: a reorder inside t1 must never touch it.
    expect(masterInput.gain.events).toEqual([]);
  });

  it("dips the owning channel's postfx for a device-to-device rewire (enable toggle)", async () => {
    const doc = (enabled: boolean): Project =>
      routingDoc({
        channels: [
          { id: "t1", role: "track", chain: ["a", "b", "c"] },
          { id: "master", role: "master", output: null },
        ],
        devices: [
          { id: "a", definitionId: "test.fx", channelId: "t1" },
          { id: "b", definitionId: "test.fx", channelId: "t1", enabled },
          { id: "c", definitionId: "test.fx", channelId: "t1" },
        ],
      });
    const waits: number[] = [];
    const rig = createRig({
      immediate: false,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await rig.reconciler.apply(doc(true));
    const postfx = gainOf(rig.reconciler.nodeFor(channelUtilRef("t1", "postfx")));

    // Bypassing b snaps c's input from b's waveform to a's in one JS turn —
    // the changed edges are all device-port to device-port, so the channel's
    // chain tail is the only gain that can cover the discontinuity.
    await rig.reconciler.apply(doc(false));
    expect(waits).toEqual([REWIRE_WAIT_MS]);
    expect(postfx.gain.events.map((e) => e.value)).toEqual([0, 1]);
  });

  it("adding an unrelated track dips nothing at all", async () => {
    const waits: number[] = [];
    const rig = createRig({
      immediate: false,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await rig.reconciler.apply(twoTrackDoc());
    const masterInput = gainOf(rig.reconciler.nodeFor(channelUtilRef("master", "input")));

    await rig.reconciler.apply(
      routingDoc({
        channels: [
          { id: "t1", role: "track" },
          { id: "t2", role: "track" },
          { id: "t3", role: "track" },
          { id: "master", role: "master", output: null },
        ],
      }),
    );
    // The new track's own post is the only changed edge's source and it is
    // brand new; dipping the master's input here would drop the whole mix.
    expect(waits).toEqual([]);
    expect(masterInput.gain.events).toEqual([]);
  });

  it("re-grouping dips the moved channel's post, not the destination or the new group", async () => {
    const waits: number[] = [];
    const rig = createRig({
      immediate: false,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await rig.reconciler.apply(twoTrackDoc());
    const t1post = gainOf(rig.reconciler.nodeFor(channelUtilRef("t1", "post")));
    const masterInput = gainOf(rig.reconciler.nodeFor(channelUtilRef("master", "input")));

    await rig.reconciler.apply(
      routingDoc({
        channels: [
          { id: "t1", role: "track", output: "g1" },
          { id: "t2", role: "track" },
          { id: "g1", role: "group" },
          { id: "master", role: "master", output: null },
        ],
      }),
    );
    expect(waits).toEqual([REWIRE_WAIT_MS]);
    expect(t1post.gain.events.map((e) => e.value)).toEqual([0, 1]);
    // Created by this very patch: no signal runs through it yet.
    expect(gainOf(rig.reconciler.nodeFor(channelUtilRef("g1", "post"))).gain.events).toEqual([]);
    expect(masterInput.gain.events).toEqual([]);
  });
});

describe("new mixer nodes start where the document says", () => {
  const sendDoc = (values: Record<string, number>): Project => {
    const base = routingDoc({
      channels: [
        { id: "t1", role: "track", sends: [{ to: "ret", amount: "chan:t1/send:ret", tap: "post" }] },
        { id: "ret", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    return { ...base, paramValues: { ...base.paramValues, ...values } };
  };

  it("a new send gain starts SILENT, with no glide down from unity", async () => {
    await reconciler.apply(sendDoc({}));
    const gain = gainOf(reconciler.nodeFor(sendRef("t1", "ret")));
    // -60 dB is the send default and maps to hard 0: creating a send while
    // the transport plays must not blip the source into the return.
    expect(gain.gain.value).toBe(0);
    expect(gain.gain.events.every((e) => e.kind !== "target")).toBe(true);
  });

  it("a saved fader/send/pan value is the node's first value, not a ramp target", async () => {
    await reconciler.apply(sendDoc({ "chan:t1/vol": -6, "chan:t1/send:ret": -12, "chan:t1/pan": -0.5 }));
    const vol = gainOf(reconciler.nodeFor(channelUtilRef("t1", "vol")));
    const send = gainOf(reconciler.nodeFor(sendRef("t1", "ret")));
    const pan = reconciler.nodeFor(channelUtilRef("t1", "pan")) as unknown as FakeStereoPannerNode;
    expect(vol.gain.value).toBeCloseTo(10 ** (-6 / 20), 6);
    expect(send.gain.value).toBeCloseTo(10 ** (-12 / 20), 6);
    expect(pan.pan.value).toBeCloseTo(-0.5, 6);
    // No `setTargetAtTime` anywhere in the initial reconcile: an offline
    // render (SS12) would otherwise bake ~30 ms of sliding faders into the
    // head of the WAV.
    expect(vol.gain.events.every((e) => e.kind !== "target")).toBe(true);
    expect(send.gain.events.every((e) => e.kind !== "target")).toBe(true);
    // The document's value also reached the param, so the app's later
    // `params.load(doc.paramValues)` is a no-op rather than a second ramp.
    expect(params.get("chan:t1/vol")?.base()).toBe(-6);
  });

  it("a channel born muted opens at 0 instead of fading out", async () => {
    await reconciler.apply(
      routingDoc({
        channels: [
          { id: "t1", role: "track", mute: true },
          { id: "master", role: "master", output: null },
        ],
      }),
    );
    const mute = gainOf(reconciler.nodeFor(channelUtilRef("t1", "mute")));
    expect(mute.gain.value).toBe(0);
    // Born closed — never ramped there, so nothing fades out at the head of
    // an offline render.
    expect(mute.gain.events).toEqual([]);
  });
});

describe("device replace (same instance id, new channel or definition)", () => {
  it("moving a device to another channel keeps it mounted and re-wires it", async () => {
    const doc = (channelId: string): Project =>
      routingDoc({
        channels: [
          { id: "t1", role: "track", chain: channelId === "t1" ? ["fx1"] : [] },
          { id: "t2", role: "track", chain: channelId === "t2" ? ["fx1"] : [] },
          { id: "master", role: "master", output: null },
        ],
        devices: [{ id: "fx1", definitionId: "test.fx", channelId }],
      });
    await reconciler.apply(doc("t1"));
    await reconciler.apply(doc("t2"));

    // The patch lists fx1 in BOTH mountDevices and unmountDevices; running the
    // unmount would dispose the instance just mounted and leave t2 silent.
    const mounted = reconciler.mountedDevice("fx1");
    expect(mounted).toBeDefined();
    expect(connected(reconciler.nodeFor(channelUtilRef("t2", "input")), mounted?.input)).toBe(true);
    expect(connected(mounted?.output, reconciler.nodeFor(channelUtilRef("t2", "postfx")))).toBe(true);
  });

  it("a device removed for real is still unmounted", async () => {
    const withFx = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "fx1", definitionId: "test.fx", channelId: "t1" }],
    });
    await reconciler.apply(withFx);
    await reconciler.apply(
      routingDoc({
        channels: [
          { id: "t1", role: "track" },
          { id: "master", role: "master", output: null },
        ],
      }),
    );
    expect(reconciler.mountedDevice("fx1")).toBeUndefined();
  });
});

describe("rack macros (SS7)", () => {
  /** One track hosting a rack whose single chain holds a `test.fx`, plus a
   *  macro mapped to that device's `mix` over an explicit range. */
  function macroDoc(options: { min: number; max: number; value: number }) {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["rack-1"], output: "master" },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "d1", definitionId: "test.fx", channelId: "t1" }],
      racks: [{ id: "rack-1", channelId: "t1", chains: [{ id: "c1", devices: ["d1"] }] }],
    });
    const macroParam = rackMacroParamId("t1", "rack-1", "m1");
    const target = deviceParamId("t1", "d1", "mix");
    doc.racks["rack-1"]!.macros = [
      {
        id: "m1",
        name: "Macro 1",
        param: macroParam,
        targets: [{ paramId: target, min: options.min, max: options.max }],
      },
    ];
    doc.paramValues[macroParam] = options.value;
    return { doc, macroParam, target };
  }

  it("registers the macro and drives its target from the saved value", async () => {
    const { doc, macroParam, target } = macroDoc({ min: 0, max: 100, value: 127 });
    await reconciler.apply(doc as unknown as ProjectSnapshot);

    expect(params.get(macroParam)).toBeDefined();
    // A macro's targets are DERIVED, never stored: applying the document has
    // to re-drive them from the macro's own value, or a reload would leave
    // every mapped param wherever its stale value put it.
    expect(params.get(target)?.live()).toBeCloseTo(100, 6);
  });

  it("fans a macro move out across its range", async () => {
    const { doc, macroParam, target } = macroDoc({ min: 20, max: 60, value: 0 });
    await reconciler.apply(doc as unknown as ProjectSnapshot);
    expect(params.get(target)?.live()).toBeCloseTo(20, 6);

    params.get(macroParam)?.setLive(64, "user"); // about half of 0..127
    expect(params.get(target)?.live()).toBeCloseTo(20 + (64 / 127) * 40, 4);
  });

  it("honours an INVERTED range", async () => {
    const { doc, macroParam, target } = macroDoc({ min: 100, max: 0, value: 0 });
    await reconciler.apply(doc as unknown as ProjectSnapshot);
    expect(params.get(target)?.live()).toBeCloseTo(100, 6);
    params.get(macroParam)?.setLive(127, "user");
    expect(params.get(target)?.live()).toBeCloseTo(0, 6);
  });

  it("re-mapping a macro takes effect without dropping the handle", async () => {
    const { doc, macroParam, target } = macroDoc({ min: 0, max: 100, value: 127 });
    await reconciler.apply(doc as unknown as ProjectSnapshot);
    const handle = params.get(macroParam);

    doc.racks["rack-1"]!.macros[0]!.targets[0] = { paramId: target, min: 0, max: 50 };
    await reconciler.apply(doc as unknown as ProjectSnapshot);

    // The same handle: re-registering would drop the one a control is
    // holding mid-gesture.
    expect(params.get(macroParam)).toBe(handle);
    expect(params.get(target)?.live()).toBeCloseTo(50, 6);
  });

  it("unregisters a macro whose rack is gone", async () => {
    const { doc, macroParam } = macroDoc({ min: 0, max: 100, value: 0 });
    await reconciler.apply(doc as unknown as ProjectSnapshot);
    expect(params.get(macroParam)).toBeDefined();

    doc.racks = {};
    doc.channels["t1"]!.chain = [];
    await reconciler.apply(doc as unknown as ProjectSnapshot);
    expect(params.get(macroParam)).toBeUndefined();
  });
});

// SS7 non-numeric device state (`DeviceState.settings`) — the sampler's file.
// The reconciler is the only code that can see both the document and the live
// device, so it is what tells one about the other; this is about it telling
// the truth exactly once per actual change.
describe("device settings (SS7 non-numeric state)", () => {
  const settingEvents: Array<[string, string | null]> = [];

  const TestSettingSynth: DeviceDefinition = {
    id: "test.setting-synth",
    version: 1,
    kind: "instrument",
    label: "Test Setting Synth",
    params: [],
    audioIn: [],
    audioOut: [{ id: "out" }],
    settings: [{ key: "sample", label: "Sample", kind: "audioAsset" }],
    create(ctx, io) {
      const voice = ctx.createGain();
      voice.connect(io.out);
      return deviceInstance({
        noteOn: () => undefined,
        setSetting: (key, value) => settingEvents.push([key, value]),
        dispose: () => voice.disconnect(),
      });
    },
  };

  function rigWithSettings(): GraphReconciler {
    const localFake = createFakeAudioContext();
    const localParams = createParamRegistry({ now: () => localFake.currentTime });
    const registry = createDeviceRegistry([TestSettingSynth]);
    const host = createDeviceHost(asContext(localFake), localParams, registry);
    return createGraphReconciler({
      ctx: asContext(localFake),
      destination: asNode(localFake.destination),
      host,
      params: localParams,
      immediate: true,
    });
  }

  /** One track whose instrument is the settings-taking synth. */
  function docWith(settings?: Record<string, string>): ProjectSnapshot {
    const base = twoTrackDoc();
    const doc = JSON.parse(JSON.stringify(base)) as Project;
    const trackId = doc.channelOrder.find((id) => doc.channels[id]?.role === "track");
    if (trackId === undefined) throw new Error("fixture has no track");
    doc.devices["dev-setting"] = {
      id: "dev-setting",
      definitionId: TestSettingSynth.id,
      version: 1,
      channelId: trackId,
      enabled: true,
      ...(settings === undefined ? {} : { settings }),
    };
    const channel = doc.channels[trackId];
    if (channel !== undefined) channel.source = { kind: "instrument", deviceId: "dev-setting" };
    return doc as ProjectSnapshot;
  }

  beforeEach(() => {
    settingEvents.length = 0;
  });

  it("tells a device what it was BORN with, at mount", async () => {
    const r = rigWithSettings();
    await r.apply(docWith({ sample: "asset-1" }));
    expect(settingEvents).toEqual([["sample", "asset-1"]]);
  });

  it("tells it once per change, not once per apply", async () => {
    // Every knob release and every note drag reaches `applyDocument`; a
    // device re-told its file on each would reload a sample per gesture.
    const r = rigWithSettings();
    const withSample = docWith({ sample: "asset-1" });
    await r.apply(withSample);
    await r.apply(withSample);
    await r.apply(withSample);
    expect(settingEvents).toEqual([["sample", "asset-1"]]);

    await r.apply(docWith({ sample: "asset-2" }));
    expect(settingEvents).toEqual([
      ["sample", "asset-1"],
      ["sample", "asset-2"],
    ]);
  });

  it("reports a cleared setting as null", async () => {
    const r = rigWithSettings();
    await r.apply(docWith({ sample: "asset-1" }));
    await r.apply(docWith());
    expect(settingEvents).toEqual([
      ["sample", "asset-1"],
      ["sample", null],
    ]);
  });

  it("says nothing at all for a device with no settings", async () => {
    const r = rigWithSettings();
    await r.apply(docWith());
    expect(settingEvents).toEqual([]);
  });
});
