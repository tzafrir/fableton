// SS6 "Validation" — DFS cycle check over output + send + sidechain edges.

import { describe, expect, it } from "vitest";
import { findRoutingCycle, routingCycleError } from "./validate";
import { routingDoc } from "./testing/docs";

describe("findRoutingCycle", () => {
  it("accepts a sound tree with sends and sidechains", () => {
    // kick sidechains the compressor on bass; bass sends to a return.
    const doc = routingDoc({
      channels: [
        { id: "kick", role: "track" },
        { id: "bass", role: "track", chain: ["comp"], sends: [{ to: "ret", amount: "x", tap: "post" }] },
        { id: "ret", role: "return" },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "comp", definitionId: "core.compressor", channelId: "bass" }],
      sidechains: [{ from: { channel: "kick", tap: "postFader" }, to: { device: "comp", port: "sc" } }],
    });
    expect(findRoutingCycle(doc)).toBeNull();
    expect(routingCycleError(doc)).toBeNull();
  });

  it("catches an output cycle (group into its own member)", () => {
    const doc = routingDoc({
      channels: [
        { id: "a", role: "group", output: "b" },
        { id: "b", role: "group", output: "a" },
        { id: "master", role: "master", output: null },
      ],
    });
    const cycle = findRoutingCycle(doc);
    expect(cycle).not.toBeNull();
    expect(routingCycleError(doc)).toMatch(/routing would loop/);
  });

  it("catches a send cycle through a return", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", sends: [{ to: "ret", amount: "x", tap: "post" }] },
        { id: "ret", role: "return", sends: [{ to: "t1", amount: "y", tap: "post" }] },
        { id: "master", role: "master", output: null },
      ],
    });
    expect(findRoutingCycle(doc)).not.toBeNull();
  });

  it("catches a sidechain-completed cycle", () => {
    // t1 sends to ret; ret sidechains a device ON t1 — that edge closes the
    // loop at the channel level, and SS6 rejects it (stricter than WebAudio
    // strictly needs for a side-chain tap, by design).
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", chain: ["comp"], sends: [{ to: "ret", amount: "x", tap: "post" }] },
        { id: "ret", role: "return" },
        { id: "master", role: "master", output: null },
      ],
      devices: [{ id: "comp", definitionId: "core.compressor", channelId: "t1" }],
      sidechains: [{ from: { channel: "ret", tap: "postFader" }, to: { device: "comp", port: "sc" } }],
    });
    expect(findRoutingCycle(doc)).not.toBeNull();
  });
});
