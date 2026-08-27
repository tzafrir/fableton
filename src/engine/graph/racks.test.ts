// SS7 racks, Phase 1: the pure half — document model -> graph description.
//
// The three properties the plan names as the proof that the model is right:
// a rack builds the expected node set, adding a chain is a purely ADDITIVE
// diff, and chain solo changes gains and not one edge.

import { describe, expect, it } from "vitest";
import { buildGraph } from "./build";
import { diffGraph } from "./diff";
import { audibleChains } from "./audible";
import {
  channelUtilRef,
  deviceInRef,
  deviceOutRef,
  parseNodeRef,
  rackChainUtilRef,
  rackUtilRef,
} from "./ids";
import { routingDoc, type DocSpec } from "./testing/docs";
import { parseParamId, rackChainParamId, rackMacroParamId } from "../../params";

const RACK = "rack-1";

/** One track hosting one rack with the given chains, plus a master. */
function rackDoc(
  chains: { id: string; devices?: string[]; mute?: boolean; solo?: boolean }[],
  options: { enabled?: boolean; devices?: DocSpec["devices"] } = {},
) {
  return routingDoc({
    channels: [
      { id: "t1", role: "track", chain: [RACK], output: "master" },
      { id: "master", role: "master", output: null },
    ],
    ...(options.devices === undefined ? {} : { devices: options.devices }),
    racks: [
      {
        id: RACK,
        channelId: "t1",
        ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
        chains,
      },
    ],
  });
}

const edgeSet = (doc: ReturnType<typeof rackDoc>): Set<string> =>
  new Set([...buildGraph(doc).edges.values()].map((e) => `${e.from}>${e.to}`));

describe("rack expansion in buildGraph", () => {
  it("splits the channel chain into parallel chains and sums them back", () => {
    const doc = rackDoc([{ id: "c1" }, { id: "c2" }]);
    const g = buildGraph(doc);
    const edges = edgeSet(doc);

    // The rack occupies the chain slot: input -> split, sum -> postfx.
    expect(edges.has(`${channelUtilRef("t1", "input")}>${rackUtilRef(RACK, "split")}`)).toBe(true);
    expect(edges.has(`${rackUtilRef(RACK, "sum")}>${channelUtilRef("t1", "postfx")}`)).toBe(true);

    for (const chain of ["c1", "c2"]) {
      const mute = rackChainUtilRef(RACK, chain, "mute");
      const gain = rackChainUtilRef(RACK, chain, "gain");
      const pan = rackChainUtilRef(RACK, chain, "pan");
      // An empty chain is the DRY path: the split lands straight on its mute.
      expect(edges.has(`${rackUtilRef(RACK, "split")}>${mute}`)).toBe(true);
      expect(edges.has(`${mute}>${gain}`)).toBe(true);
      expect(edges.has(`${gain}>${pan}`)).toBe(true);
      expect(edges.has(`${pan}>${rackUtilRef(RACK, "sum")}`)).toBe(true);
      expect(g.utils.get(pan)?.type).toBe("panner");
      expect(g.utils.get(gain)?.rackId).toBe(RACK);
      expect(g.utils.get(gain)?.chainId).toBe(chain);
      // The hosting CHANNEL is carried on every rack node — the reconciler
      // dips channel boundaries around a rewire and needs to know which.
      expect(g.utils.get(mute)?.channelId).toBe("t1");
    }

    // With chains present the rack does NOT also pass dry through the sum,
    // or every chain would be doubled by an unattenuated copy.
    expect(edges.has(`${rackUtilRef(RACK, "split")}>${rackUtilRef(RACK, "sum")}`)).toBe(false);
  });

  it("threads a chain's devices between the split and the chain's mute", () => {
    const doc = rackDoc([{ id: "c1", devices: ["d1", "d2"] }], {
      devices: [
        { id: "d1", definitionId: "core.reverb", channelId: "t1" },
        { id: "d2", definitionId: "core.filter", channelId: "t1" },
      ],
    });
    const edges = edgeSet(doc);
    expect(edges.has(`${rackUtilRef(RACK, "split")}>${deviceInRef("d1")}`)).toBe(true);
    expect(edges.has(`${deviceOutRef("d1")}>${deviceInRef("d2")}`)).toBe(true);
    expect(edges.has(`${deviceOutRef("d2")}>${rackChainUtilRef(RACK, "c1", "mute")}`)).toBe(true);
    // Devices inside a rack mount on the HOSTING channel — their params keep
    // living at `chan:<host>/dev:<id>/...`, so nothing about a device changes
    // when it moves into a rack.
    expect(buildGraph(doc).mounts.get("d1")?.channelId).toBe("t1");
  });

  it("bypasses a disabled rack and an empty one, keeping the devices mounted", () => {
    const doc = rackDoc([{ id: "c1", devices: ["d1"] }], {
      enabled: false,
      devices: [{ id: "d1", definitionId: "core.reverb", channelId: "t1" }],
    });
    const g = buildGraph(doc);
    const edges = edgeSet(doc);
    expect(edges.has(`${rackUtilRef(RACK, "split")}>${rackUtilRef(RACK, "sum")}`)).toBe(true);
    expect(edges.has(`${rackUtilRef(RACK, "split")}>${deviceInRef("d1")}`)).toBe(false);
    // Mounted but out of the path — the same rule a disabled device follows,
    // so re-enabling is an edge diff and the device keeps its state (SS7).
    expect(g.mounts.has("d1")).toBe(true);

    const emptyRack = buildGraph(rackDoc([]));
    expect(
      [...emptyRack.edges.values()].some(
        (e) => e.from === rackUtilRef(RACK, "split") && e.to === rackUtilRef(RACK, "sum"),
      ),
    ).toBe(true);
  });

  it("adding a chain is a purely additive diff", () => {
    const before = buildGraph(rackDoc([{ id: "c1" }]));
    const after = buildGraph(rackDoc([{ id: "c1" }, { id: "c2" }]));
    const patch = diffGraph(before, after);

    expect(patch.disconnect).toEqual([]);
    expect(patch.disposeUtils).toEqual([]);
    expect(patch.unmountDevices).toEqual([]);
    expect(patch.createUtils.map((u) => u.ref).sort()).toEqual(
      [
        rackChainUtilRef(RACK, "c2", "gain"),
        rackChainUtilRef(RACK, "c2", "mute"),
        rackChainUtilRef(RACK, "c2", "pan"),
      ].sort(),
    );
    expect(patch.connect).toHaveLength(4); // split->mute->gain->pan->sum
  });

  it("chain solo changes gains, not one edge", () => {
    const quiet = buildGraph(rackDoc([{ id: "c1" }, { id: "c2" }]));
    const soloed = buildGraph(rackDoc([{ id: "c1", solo: true }, { id: "c2" }]));
    expect(diffGraph(quiet, soloed)).toEqual({
      createUtils: [],
      mountDevices: [],
      disconnect: [],
      connect: [],
      unmountDevices: [],
      disposeUtils: [],
    });
  });
});

describe("audibleChains", () => {
  const chains = (spec: { id: string; mute?: boolean; solo?: boolean }[]) =>
    spec.map((c) => ({ id: c.id, mute: c.mute ?? false, solo: c.solo ?? false }));

  it("opens everything unmuted when nothing is soloed", () => {
    expect(audibleChains(chains([{ id: "a" }, { id: "b", mute: true }]))).toEqual(new Set(["a"]));
  });

  it("opens only the soloed chains, overriding their own mute", () => {
    const set = audibleChains(chains([{ id: "a" }, { id: "b", mute: true, solo: true }]));
    expect(set).toEqual(new Set(["b"]));
  });

  it("is empty for a rack with no chains", () => {
    expect(audibleChains([])).toEqual(new Set());
  });
});

describe("rack id grammar", () => {
  it("round-trips chain and macro param ids", () => {
    const gain = rackChainParamId("t1", RACK, "c1", "gain");
    expect(gain).toBe(`chan:t1/dev:${RACK}/chain:c1/gain`);
    expect(parseParamId(gain)).toEqual({
      kind: "rackChain",
      channelId: "t1",
      rackId: RACK,
      chainId: "c1",
      leaf: "gain",
    });

    const macro = rackMacroParamId("t1", RACK, "m1");
    expect(parseParamId(macro)).toEqual({
      kind: "rackMacro",
      channelId: "t1",
      rackId: RACK,
      macroId: "m1",
    });
  });

  it("rejects a malformed chain leaf rather than guessing", () => {
    expect(parseParamId(`chan:t1/dev:${RACK}/chain:c1/wobble`)).toBeNull();
    expect(parseParamId(`chan:t1/dev:${RACK}/chain:/gain`)).toBeNull();
    expect(parseParamId(`chan:t1/dev:${RACK}/macro:`)).toBeNull();
  });

  it("round-trips rack node refs", () => {
    expect(parseNodeRef(rackUtilRef(RACK, "split"))).toEqual({ kind: "rack", rackId: RACK, util: "split" });
    expect(parseNodeRef(rackChainUtilRef(RACK, "c1", "pan"))).toEqual({
      kind: "rackChain",
      rackId: RACK,
      chainId: "c1",
      util: "pan",
    });
    expect(parseNodeRef(`rack:${RACK}/chain:c1/wobble`)).toBeNull();
    expect(parseNodeRef(`rack:/split`)).toBeNull();
  });
});
