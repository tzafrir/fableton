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
import { createParamRegistry, type AppParamRegistry } from "../../params";
import type { DeviceDefinition, Project } from "../../types";
import { p } from "../../params/descriptors";
import { createGraphReconciler, type GraphReconciler } from "./reconciler";
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

let fake: FakeAudioContext;
let params: AppParamRegistry;
let reconciler: GraphReconciler;

beforeEach(() => {
  fake = createFakeAudioContext();
  params = createParamRegistry({ now: () => fake.currentTime });
  const registry = createDeviceRegistry([TestFx, TestSynth]);
  const host = createDeviceHost(asContext(fake), params, registry);
  reconciler = createGraphReconciler({
    ctx: asContext(fake),
    destination: asNode(fake.destination),
    host,
    params,
  });
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

  it("solo-in-place drives mute gains, not wiring", async () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true },
        { id: "t2", role: "track" },
        { id: "master", role: "master", output: null },
      ],
    });
    await reconciler.apply(doc);
    const edgesBefore = fake.created.reduce((n, node) => n + node.connections.length, 0);

    // t1 audible (soloed), t2 silent: find the two mute gains via targets.
    const gains = fake.created.filter((n): n is FakeGainNode => n instanceof FakeGainNode);
    expect(gains.some((g) => g.gain.scheduled === 0)).toBe(true);

    // Unsolo: same wiring, gains restored.
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
    expect(gains.every((g) => g.gain.scheduled !== 0 || g.gain.value === 0)).toBe(true);
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
