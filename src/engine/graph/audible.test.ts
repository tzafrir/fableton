// SS6 "Solo / mute" — solo-in-place as a pure function over fixtures.

import { describe, expect, it } from "vitest";
import { audibleChannels } from "./audible";
import { routingDoc } from "./testing/docs";

const send = (to: string) => ({ to, amount: `send:${to}`, tap: "post" as const });

describe("audibleChannels", () => {
  it("no solos: audible = neither muted nor under a muted ancestor", () => {
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

  it("muting a group silences its members' SENDS too, not just their dry path", () => {
    // The send leaves the member's own post node straight into the return
    // (build.ts) — it never passes through the group's mute gain, so the
    // member has to be closed itself or its reverb tail plays on.
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", output: "g1", sends: [send("retA")] },
        { id: "g1", role: "group", mute: true },
        { id: "retA", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    const audible = audibleChannels(doc);
    expect(audible.has("t1")).toBe(false);
    expect(audible.has("g1")).toBe(false);
    // retA itself stays OPEN (with no solo anywhere, a return is closed only
    // by its own mute) — it simply receives nothing, because t1's send tap
    // sits downstream of t1's now-closed mute gain.
    expect(audible.has("retA")).toBe(true);
    expect(audible.has("master")).toBe(true);
  });

  it("mute propagates through nested groups", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", output: "inner" },
        { id: "inner", role: "group", output: "outer" },
        { id: "outer", role: "group", mute: true },
        { id: "master", role: "master", output: null },
      ],
    });
    const audible = audibleChannels(doc);
    expect(audible.has("t1")).toBe(false);
    expect(audible.has("inner")).toBe(false);
  });

  it("terminates on a cyclic output chain (malformed doc)", () => {
    const doc = routingDoc({
      channels: [
        { id: "a", role: "group", output: "b" },
        { id: "b", role: "group", output: "a", mute: true },
        { id: "master", role: "master", output: null },
      ],
    });
    expect(audibleChannels(doc).has("b")).toBe(false);
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

  it("a muted ancestor group beats a soloed member — including the member's sends", () => {
    const doc = routingDoc({
      channels: [
        { id: "t1", role: "track", solo: true, output: "g1", sends: [send("retA")] },
        { id: "g1", role: "group", mute: true },
        { id: "retA", role: "return" },
        { id: "master", role: "master", output: null },
      ],
    });
    const audible = audibleChannels(doc);
    expect(audible.has("g1")).toBe(false);
    // Solo overrides the channel's OWN mute, never a muted ancestor's: leaving
    // t1 open would send its wet signal round the muted group into the return.
    expect(audible.has("t1")).toBe(false);
    expect(audible.has("retA")).toBe(false);
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
