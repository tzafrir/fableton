// SS6 "Solo / mute" — solo-in-place as a pure function over fixtures.

import { describe, expect, it } from "vitest";
import { audibleChannels } from "./audible";
import { routingDoc } from "./testing/docs";

const send = (to: string) => ({ to, amount: `send:${to}`, tap: "post" as const });

describe("audibleChannels", () => {
  it("no solos: audible = not muted; a muted group only silences itself (graph does the rest)", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track" },
        { id: "t2", role: "track", mute: true },
        { id: "g1", role: "group", mute: true },
        { id: "master", role: "master", output: null },
      ],
    });
    const audible = audibleChannels(doc);
    expect(audible.has("t1")).toBe(true);
    expect(audible.has("t2")).toBe(false);
    expect(audible.has("g1")).toBe(false);
    expect(audible.has("master")).toBe(true);
  });

  it("soloing a track keeps only it, its path, and the master audible", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true, output: "g1" },
        { id: "t2", role: "track" },
        { id: "g1", role: "group" },
        { id: "master", role: "master", output: null },
      ],
    });
    const audible = audibleChannels(doc);
    expect(audible.has("t1")).toBe(true);
    expect(audible.has("g1")).toBe(true); // ancestor: the signal path stays open
    expect(audible.has("t2")).toBe(false);
    expect(audible.has("master")).toBe(true);
  });

  it("solo overrides the soloed channel's own mute", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true, mute: true },
        { id: "t2", role: "track" },
        { id: "master", role: "master", output: null },
      ],
    });
    expect(audibleChannels(doc).has("t1")).toBe(true);
    expect(audibleChannels(doc).has("t2")).toBe(false);
  });

  it("soloing a group solos its members, but a member's own mute is respected", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", output: "g1" },
        { id: "t2", role: "track", output: "g1", mute: true },
        { id: "t3", role: "track" },
        { id: "g1", role: "group", solo: true },
        { id: "master", role: "master", output: null },
      ],
    });
    const audible = audibleChannels(doc);
    expect(audible.has("t1")).toBe(true);
    expect(audible.has("t2")).toBe(false); // muted inside the soloed group
    expect(audible.has("t3")).toBe(false);
  });

  it("a muted ancestor group beats a soloed member (path respects its own mute)", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true, output: "g1" },
        { id: "g1", role: "group", mute: true },
        { id: "master", role: "master", output: null },
      ],
    });
    expect(audibleChannels(doc).has("g1")).toBe(false);
  });

  it("returns fed by a soloed track stay audible, transitively", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true, sends: [send("retA")] },
        { id: "t2", role: "track", sends: [send("retB")] },
        { id: "retA", role: "return", sends: [send("retB")] },
        { id: "retB", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    const audible = audibleChannels(doc);
    expect(audible.has("retA")).toBe(true); // fed by soloed t1
    expect(audible.has("retB")).toBe(true); // fed by audible retA (fixpoint)
    expect(audible.has("t2")).toBe(false); // not soloed — its send is silent anyway
  });

  it("a return fed only by a non-soloed track goes silent under solo", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true },
        { id: "t2", role: "track", sends: [send("retA")] },
        { id: "retA", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    expect(audibleChannels(doc).has("retA")).toBe(false);
  });
});
