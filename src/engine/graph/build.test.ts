// SS6 + SS15: "reconciler tests diff document fixtures and assert patch
// sets — no browser needed for any of the load-bearing logic." These cover
// `buildGraph` (document -> description) and `diffGraph` (description ->
// patch); the live application half is reconciler.test.ts.

import { describe, expect, it } from "vitest";
import { buildGraph, sidechainTapRef } from "./build";
import { diffGraph } from "./diff";
import { isEmptyPatch } from "../../types/graph";
import { channelUtilRef, deviceInRef, deviceOutRef, devicePortRef, edgeId, sendRef, DESTINATION_REF } from "./ids";
import { routingDoc, twoTrackDoc } from "./testing/docs";

function edgeSet(doc: Parameters<typeof buildGraph>[0]): Set<string> {
  return new Set(buildGraph(doc).edges.keys());
}

describe("buildGraph", () => {
  it("is pure: equal documents produce deep-equal descriptions", () => {
    const a = buildGraph(twoTrackDoc());
    const b = buildGraph(twoTrackDoc());
    expect([...a.utils.keys()]).toEqual([...b.utils.keys()]);
    expect([...a.edges.keys()]).toEqual([...b.edges.keys()]);
    expect([...a.mounts.keys()]).toEqual([...b.mounts.keys()]);
    expect(isEmptyPatch(diffGraph(a, b))).toBe(true);
  });

  it("builds the SS6 per-channel spine and routes tracks into the master", () => {
    const g = buildGraph(twoTrackDoc());
    const edges = new Set(g.edges.keys());
    // t1 spine
    expect(edges.has(edgeId(channelUtilRef("t1", "input"), channelUtilRef("t1", "postfx")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("t1", "postfx"), channelUtilRef("t1", "mute")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("t1", "mute"), channelUtilRef("t1", "vol")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("t1", "vol"), channelUtilRef("t1", "pan")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("t1", "pan"), channelUtilRef("t1", "post")))).toBe(true);
    // outputs
    expect(edges.has(edgeId(channelUtilRef("t1", "post"), channelUtilRef("master", "input")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("master", "post"), DESTINATION_REF))).toBe(true);
  });

  it("threads the effect chain in order and mounts every device", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1", "fx2"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [
        { id: "fx1", definitionId: "core.filter", channelId: "t1" },
        { id: "fx2", definitionId: "core.filter", channelId: "t1" },
      ],
    });
    const g = buildGraph(doc);
    expect([...g.mounts.keys()].sort()).toEqual(["fx1", "fx2"]);
    const edges = new Set(g.edges.keys());
    expect(edges.has(edgeId(channelUtilRef("t1", "input"), deviceInRef("fx1")))).toBe(true);
    expect(edges.has(edgeId(deviceOutRef("fx1"), deviceInRef("fx2")))).toBe(true);
    expect(edges.has(edgeId(deviceOutRef("fx2"), channelUtilRef("t1", "postfx")))).toBe(true);
  });

  it("bypasses a disabled effect but keeps it mounted", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1", "fx2"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [
        { id: "fx1", definitionId: "core.filter", channelId: "t1", enabled: false },
        { id: "fx2", definitionId: "core.filter", channelId: "t1" },
      ],
    });
    const g = buildGraph(doc);
    expect(g.mounts.has("fx1")).toBe(true); // stays mounted, keeps its state
    const edges = new Set(g.edges.keys());
    expect(edges.has(edgeId(channelUtilRef("t1", "input"), deviceInRef("fx2")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("t1", "input"), deviceInRef("fx1")))).toBe(false);
    expect(edges.has(edgeId(deviceOutRef("fx1"), deviceInRef("fx2")))).toBe(false);
  });

  it("routes a source instrument into the channel input", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", source: { kind: "instrument", deviceId: "synth" } },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "synth", definitionId: "core.poly-synth", channelId: "t1" }],
    });
    const edges = edgeSet(doc);
    expect(edges.has(edgeId(deviceOutRef("synth"), channelUtilRef("t1", "input")))).toBe(true);
  });

  it("groups: a member's post feeds the group input; nesting chains", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", output: "inner" },
        { id: "inner", role: "group", output: "outer" },
        { id: "outer", role: "group", output: "master" },
        { id: "master", role: "master", output: null },
      ],
    });
    const edges = edgeSet(doc);
    expect(edges.has(edgeId(channelUtilRef("t1", "post"), channelUtilRef("inner", "input")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("inner", "post"), channelUtilRef("outer", "input")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("outer", "post"), channelUtilRef("master", "input")))).toBe(true);
  });

  it("sends: pre taps the mute output, post taps the post node, both feed the return input", () => {
    const doc = routingDoc({
      channels: [
        {
          id: "t1",
          role: "track",
          sends: [
            { to: "retA", amount: "chan:t1/send:retA", tap: "pre" },
            { to: "retB", amount: "chan:t1/send:retB", tap: "post" },
          ],
        },
        { id: "retA", role: "return" },
        { id: "retB", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    const g = buildGraph(doc);
    expect(g.utils.get(sendRef("t1", "retA"))?.kind).toBe("send");
    const edges = new Set(g.edges.keys());
    expect(edges.has(edgeId(channelUtilRef("t1", "mute"), sendRef("t1", "retA")))).toBe(true);
    expect(edges.has(edgeId(channelUtilRef("t1", "post"), sendRef("t1", "retB")))).toBe(true);
    expect(edges.has(edgeId(sendRef("t1", "retA"), channelUtilRef("retA", "input")))).toBe(true);
    expect(edges.has(edgeId(sendRef("t1", "retB"), channelUtilRef("retB", "input")))).toBe(true);
  });

  it("sidechain: connects the tap node to the device's sc port", () => {
    const doc = routingDoc({
      channels: [
        { id: "kick", role: "track" },
        { id: "bass", role: "track", chain: ["comp"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "comp", definitionId: "core.compressor", channelId: "bass" }],
      sidechains: [
        { from: { channel: "kick", tap: "postFader" }, to: { device: "comp", port: "sc" } },
      ],
    });
    const edges = edgeSet(doc);
    expect(edges.has(edgeId(channelUtilRef("kick", "post"), devicePortRef("comp", "sc")))).toBe(true);
  });

  it("sidechainTapRef maps the three SS6 tap points", () => {
    expect(sidechainTapRef("c", "preFx")).toBe(channelUtilRef("c", "input"));
    expect(sidechainTapRef("c", "postFx")).toBe(channelUtilRef("c", "postfx"));
    expect(sidechainTapRef("c", "postFader")).toBe(channelUtilRef("c", "post"));
  });
});

describe("diffGraph", () => {
  it("adding a track patches only the new channel's nodes and edges", () => {
    const before = buildGraph(twoTrackDoc());
    const withThird = routingDoc({
      channels: [
        { id: "t1", role: "track" },
        { id: "t2", role: "track" },
        { id: "t3", role: "track" },
        { id: "master", role: "master", output: null },
      ],
    });
    const patch = diffGraph(before, buildGraph(withThird));
    expect(patch.disconnect).toEqual([]);
    expect(patch.disposeUtils).toEqual([]);
    expect(patch.createUtils.every((u) => u.channelId === "t3")).toBe(true);
    expect(patch.connect.every((e) => e.from.includes("t3") || e.to.includes("t3"))).toBe(true);
  });

  it("moving a track into a group is a one-edge rewire", () => {
    const flat = routingDoc({
      channels: [
        { id: "t1", role: "track" },
        { id: "g1", role: "group" },
        { id: "master", role: "master", output: null },
      ],
    });
    const grouped = routingDoc({
      channels: [
        { id: "t1", role: "track", output: "g1" },
        { id: "g1", role: "group" },
        { id: "master", role: "master", output: null },
      ],
    });
    const patch = diffGraph(buildGraph(flat), buildGraph(grouped));
    expect(patch.createUtils).toEqual([]);
    expect(patch.disconnect).toEqual([
      { from: channelUtilRef("t1", "post"), to: channelUtilRef("master", "input") },
    ]);
    expect(patch.connect).toEqual([
      { from: channelUtilRef("t1", "post"), to: channelUtilRef("g1", "input") },
    ]);
  });

  it("toggling a device's enable is a pure edge diff — no mount churn", () => {
    const on = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "fx1", definitionId: "core.filter", channelId: "t1" }],
    });
    const off = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "fx1", definitionId: "core.filter", channelId: "t1", enabled: false }],
    });
    const patch = diffGraph(buildGraph(on), buildGraph(off));
    expect(patch.mountDevices).toEqual([]);
    expect(patch.unmountDevices).toEqual([]);
    expect(patch.disconnect.length).toBe(2);
    expect(patch.connect).toEqual([
      { from: channelUtilRef("t1", "input"), to: channelUtilRef("t1", "postfx") },
    ]);
  });

  it("swapping a device definition under the same instance id remounts it", () => {
    const a = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "fx1", definitionId: "core.filter", channelId: "t1" }],
    });
    const b = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["fx1"] },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "fx1", definitionId: "core.delay", channelId: "t1" }],
    });
    const patch = diffGraph(buildGraph(a), buildGraph(b));
    // A REPLACE lists the instance in BOTH lists. The reconciler's mount loop
    // is what tears the stale instance down, so it must NOT also run the
    // unmount (reconciler.ts) — see "device replace" in reconciler.test.ts.
    expect(patch.unmountDevices).toEqual(["fx1"]);
    expect(patch.mountDevices.map((m) => m.definitionId)).toEqual(["core.delay"]);
  });

  it("deleting a channel disposes its nodes and disconnects everything it touched", () => {
    const before = buildGraph(twoTrackDoc());
    const after = buildGraph(
      routingDoc({
        channels: [
          { id: "t1", role: "track" },
          { id: "master", role: "master", output: null },
        ],
      }),
    );
    const patch = diffGraph(before, after);
    expect(patch.disposeUtils.every((r) => r.startsWith("chan:t2/"))).toBe(true);
    expect(patch.disposeUtils.length).toBe(6);
    expect(patch.disconnect.some((e) => e.from === channelUtilRef("t2", "post"))).toBe(true);
  });
});
